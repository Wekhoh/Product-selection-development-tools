#!/usr/bin/env python3
"""
Stage-2 reusable 4x4 annotated visual contact-sheet PNG generator (DECISIONS.md 2026-11-19).
Supports offline local image paths (for deterministic tests and cached thumbnails) as well as
HTTP/HTTPS image URLs with polite timeouts and graceful [NO IMAGE] fallback.
Outputs a crisp white 1px-hairline grid annotated with #idx, ASIN, price/promo, monthly sales,
reviews/rating, FBA/package summary, and optional visual cluster tag.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import ipaddress
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MiB hard read cap before decoding
MAX_REDIRECTS = 5


def _is_public_http_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parsed.scheme.lower() not in ("http", "https"):
        return False
    host = parsed.hostname
    if not host:
        return False
    lower_host = host.strip().lower()
    if lower_host in ("localhost", "localhost.localdomain") or lower_host.endswith(".local"):
        return False
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme.lower() == "https" else 80), type=socket.SOCK_STREAM)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        addr_str = info[4][0]
        try:
            ip = ipaddress.ip_address(addr_str)
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
                ip = ip.ipv4_mapped
            if not ip.is_global or ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
                return False
        except ValueError:
            return False
    return True


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self) -> None:
        self._hops = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self._hops += 1
        if self._hops > MAX_REDIRECTS:
            raise urllib.error.URLError("Too many redirects")
        resolved = urllib.parse.urljoin(req.full_url, newurl)
        if not _is_public_http_url(resolved):
            raise urllib.error.URLError("Redirect target blocked by destination policy")
        return super().redirect_request(req, fp, code, msg, headers, resolved)


def _read_bounded(resp, max_bytes: int = MAX_IMAGE_BYTES) -> bytes | None:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = resp.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        # Windows clean sans / CJK-capable fonts
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        # Linux CI standard fonts
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def safe_text(value: Any, fallback: str = "-") -> str:
    if value is None:
        return fallback
    text = str(value).strip()
    return text if text else fallback


def fmt_money(value: Any) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"${value:.2f}"
    return "-"


def fmt_int(value: Any) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{int(round(value)):,}"
    return "-"


def truncate(text: str, limit: int) -> str:
    clean = " ".join(text.split())
    if len(clean) <= limit:
        return clean
    return clean[: max(1, limit - 1)].rstrip() + "..."


def fetch_image(item: dict[str, Any], base_dir: Path, offline: bool, timeout: float) -> tuple[Image.Image | None, str]:
    local_path = item.get("image_path")
    if isinstance(local_path, str) and local_path.strip():
        p = Path(local_path.strip())
        if not p.is_absolute():
            cand = base_dir / p
            p = cand if cand.exists() else Path.cwd() / p
        if p.exists():
            try:
                with Image.open(p) as img:
                    return ImageOps.exif_transpose(img).convert("RGB"), "local"
            except OSError:
                return None, "local_unreadable"

    url = item.get("image_url")
    if not offline and isinstance(url, str) and url.strip().lower().startswith(("http://", "https://")):
        clean_url = url.strip()
        if not _is_public_http_url(clean_url):
            return None, "http_blocked"
        req = urllib.request.Request(
            clean_url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; ProductSelectionContactSheet/1.0)"},
        )
        opener = urllib.request.build_opener(_SafeRedirectHandler())
        try:
            with opener.open(req, timeout=timeout) as resp:
                final_url = getattr(resp, "geturl", lambda: clean_url)()
                if not _is_public_http_url(final_url):
                    return None, "http_blocked"
                data = _read_bounded(resp, MAX_IMAGE_BYTES)
                if data is None:
                    return None, "http_too_large"
            with Image.open(io.BytesIO(data)) as img:
                return ImageOps.exif_transpose(img).convert("RGB"), "http"
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return None, "http_failed"

    return None, "missing"


def render_contact_sheet(
    items: list[dict[str, Any]],
    output_path: Path,
    *,
    title: str = "Stage-2 Visual Peer Contact Sheet",
    cols: int = 4,
    rows: int = 4,
    cell_width: int = 360,
    cell_height: int = 440,
    base_dir: Path | None = None,
    offline: bool = False,
    timeout: float = 10.0,
) -> dict[str, Any]:
    if cols < 1 or rows < 1:
        raise ValueError("cols and rows must be positive integers.")
    max_items = cols * rows
    selected = items[:max_items]
    actual_rows = max(1, (len(selected) + cols - 1) // cols) if selected else 1

    header_h = 64
    pad = 16
    gap = 12
    canvas_w = pad * 2 + cols * cell_width + (cols - 1) * gap
    canvas_h = header_h + pad + actual_rows * cell_height + (actual_rows - 1) * gap + pad

    canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    font_title = load_font(20, bold=True)
    font_sub = load_font(13, bold=False)
    font_badge = load_font(14, bold=True)
    font_meta = load_font(13, bold=True)
    font_small = load_font(12, bold=False)

    # Crisp header bar with 1px hairline rule
    draw.text((pad, 14), truncate(title, 96), fill=(17, 17, 17), font=font_title)
    subtitle = f"Showing {len(selected)} of {len(items)} peers | Grid {cols}x{actual_rows} | Mode: {'offline' if offline else 'online+local'}"
    draw.text((pad, 41), subtitle, fill=(102, 102, 102), font=font_sub)
    draw.line([(0, header_h - 1), (canvas_w, header_h - 1)], fill=(224, 224, 224), width=1)

    loaded = 0
    missing = 0
    resolved_base = base_dir or Path.cwd()
    manifest_rows: list[dict[str, Any]] = []

    for i, item in enumerate(selected):
        r = i // cols
        c = i % cols
        x0 = pad + c * (cell_width + gap)
        y0 = header_h + pad + r * (cell_height + gap)
        x1 = x0 + cell_width
        y1 = y0 + cell_height

        # Hairline cell border
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=(255, 255, 255), outline=(224, 224, 224), width=1)

        img_box_h = cell_height - 122
        img_pad = 10
        img_w = cell_width - img_pad * 2
        img_h = max(80, img_box_h - img_pad * 2)

        img, source_kind = fetch_image(item, resolved_base, offline=offline, timeout=timeout)
        if img is not None:
            loaded += 1
            thumb = ImageOps.contain(img, (img_w, img_h))
            tx = x0 + img_pad + (img_w - thumb.width) // 2
            ty = y0 + img_pad + (img_h - thumb.height) // 2
            canvas.paste(thumb, (tx, ty))
        else:
            missing += 1
            draw.rectangle(
                [x0 + img_pad, y0 + img_pad, x1 - img_pad, y0 + img_box_h - img_pad],
                fill=(246, 246, 246),
                outline=(216, 216, 216),
                width=1,
            )
            draw.text((x0 + cell_width // 2 - 42, y0 + img_box_h // 2 - 8), "[NO IMAGE]", fill=(120, 120, 120), font=font_badge)

        # Top-left index badge (#01)
        idx_num = item.get("tile_index") or item.get("idx", i + 1)
        idx_label = f"#{int(idx_num):02d}" if isinstance(idx_num, int) else f"#{safe_text(idx_num)}"
        draw.rectangle([x0 + 8, y0 + 8, x0 + 54, y0 + 32], fill=(17, 17, 17))
        draw.text((x0 + 16, y0 + 12), idx_label, fill=(255, 255, 255), font=font_badge)

        # Optional cluster badge top-right
        cluster = item.get("cluster")
        if isinstance(cluster, str) and cluster.strip():
            cl_text = truncate(cluster.strip(), 14)
            cl_w = max(56, len(cl_text) * 8 + 16)
            draw.rectangle([x1 - cl_w - 8, y0 + 8, x1 - 8, y0 + 32], fill=(242, 244, 247), outline=(180, 188, 198), width=1)
            draw.text((x1 - cl_w, y0 + 12), cl_text, fill=(25, 45, 70), font=font_small)

        # Hairline divider before metadata footer
        fy = y0 + img_box_h
        draw.line([(x0, fy), (x1 - 1, fy)], fill=(232, 232, 232), width=1)

        asin = safe_text(item.get("asin") or item.get("candidate_id") or item.get("id"), f"ITEM-{i + 1}")
        list_price = item.get("list_price_usd", item.get("price_usd", item.get("price")))
        net_price = item.get("net_price_usd", item.get("promo_price_usd", item.get("net_effective_price_usd")))
        if list_price is None and isinstance(net_price, (int, float)) and not isinstance(net_price, bool):
            list_price = net_price
        discount_usd = item.get("discount_usd")
        if net_price is None and isinstance(list_price, (int, float)) and isinstance(discount_usd, (int, float)) and discount_usd > 0:
            net_price = round(list_price - discount_usd, 2)
        promo_text = safe_text(item.get("promo_text"), "")

        price_str = fmt_money(list_price)
        if isinstance(net_price, (int, float)) and isinstance(list_price, (int, float)) and net_price < list_price - 0.005:
            price_str = f"{fmt_money(net_price)} (list {fmt_money(list_price)})"
        elif isinstance(net_price, (int, float)) and list_price is None:
            price_str = fmt_money(net_price)
        if promo_text:
            price_str = f"{price_str} [{truncate(promo_text, 14)}]"

        sales = item.get("monthly_units", item.get("monthlySales", item.get("sales_30d", item.get("units", item.get("sales")))))
        reviews = item.get("reviews", item.get("review_count", item.get("ratings")))
        rating = item.get("rating")
        rating_str = f"{rating:.1f}*" if isinstance(rating, (int, float)) else "-"
        fulfill = safe_text(item.get("fulfillment_channel", item.get("fulfillment")), "FBA")
        fba_fee = item.get("fba_fee_usd")
        fba_str = f"FBA {fmt_money(fba_fee)}" if isinstance(fba_fee, (int, float)) else fulfill
        raw_dims = safe_text(item.get("pkgDimensions", item.get("pkg_dimensions")), "")
        raw_wt = safe_text(item.get("pkgWeight", item.get("pkg_weight")), "")
        fallback_pkg = " / ".join(p for p in (raw_dims, raw_wt) if p)
        pkg = safe_text(item.get("pkg_summary"), fallback_pkg)
        item_title = truncate(safe_text(item.get("title"), ""), 46)

        line1 = f"{asin} | {price_str}"
        line2 = f"Sales {fmt_int(sales)}/mo | Rev {fmt_int(reviews)} ({rating_str})"
        line3 = f"{fba_str}" + (f" | {truncate(pkg, 28)}" if pkg else "")

        draw.text((x0 + 10, fy + 8), truncate(line1, 44), fill=(17, 17, 17), font=font_meta)
        draw.text((x0 + 10, fy + 30), truncate(line2, 44), fill=(55, 55, 55), font=font_small)
        draw.text((x0 + 10, fy + 50), truncate(line3, 44), fill=(90, 90, 90), font=font_small)
        if item_title:
            draw.text((x0 + 10, fy + 72), item_title, fill=(102, 102, 102), font=font_small)

        effective_price = net_price if isinstance(net_price, (int, float)) else list_price
        manifest_rows.append(
            {
                "idx": idx_num,
                "asin": asin,
                "image_status": source_kind,
                "list_price_usd": list_price,
                "net_price_usd": effective_price,
                "price_usd": list_price,
                "promo_price_usd": net_price,
                "promo_text": promo_text or None,
                "monthly_units": sales,
                "sales_30d": sales,
                "reviews": reviews,
                "rating": rating,
                "fulfillment": fulfill,
                "fba_fee_usd": fba_fee,
                "cluster": cluster,
                "rendered_price_label": price_str,
            }
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG", optimize=True)
    sha = hashlib.sha256(output_path.read_bytes()).hexdigest()
    return {
        "ok": True,
        "output_path": str(output_path),
        "sha256": sha,
        "items_total": len(items),
        "items_rendered": len(selected),
        "images_loaded": loaded,
        "images_missing": missing,
        "width": canvas_w,
        "height": canvas_h,
        "rows": manifest_rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a reusable 4x4 annotated peer contact sheet PNG.")
    parser.add_argument("--input", required=True, help="JSON file containing a list of items or { title, items[] }.")
    parser.add_argument("--output", required=True, help="Output PNG file path.")
    parser.add_argument("--title", default=None, help="Header title override.")
    parser.add_argument("--cols", type=int, default=4, help="Grid columns (default: 4).")
    parser.add_argument("--rows", type=int, default=4, help="Grid rows (default: 4).")
    parser.add_argument("--cell-width", type=int, default=360, help="Cell width in pixels.")
    parser.add_argument("--cell-height", type=int, default=440, help="Cell height in pixels.")
    parser.add_argument("--timeout", type=float, default=10.0, help="HTTP fetch timeout in seconds.")
    parser.add_argument("--offline", action="store_true", help="Disable HTTP image fetches; only load local image_path.")
    parser.add_argument("--manifest-out", default=None, help="Optional JSON manifest output path.")
    args = parser.parse_args(argv)

    in_path = Path(args.input).resolve()
    try:
        raw_text = in_path.read_text(encoding="utf-8")
    except OSError:
        raise ValueError(f"Unable to read input JSON file ({in_path.name}).")
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError:
        raise ValueError(f"Invalid JSON syntax in input file ({in_path.name}).")

    if isinstance(raw, list):
        items = raw
        in_title = None
    elif isinstance(raw, dict) and any(isinstance(raw.get(key), list) for key in ("listings", "candidates", "items")):
        items = next(raw[key] for key in ("listings", "candidates", "items") if isinstance(raw.get(key), list))
        in_title = raw.get("title")
    elif isinstance(raw, dict) and isinstance(raw.get("mainstream_pool"), list):
        items = raw["mainstream_pool"]
        in_title = raw.get("title")
    elif isinstance(raw, dict) and isinstance(raw.get("analysis"), dict) and isinstance(raw["analysis"].get("mainstream_pool"), list):
        items = raw["analysis"]["mainstream_pool"]
        in_title = raw.get("title")
    else:
        raise ValueError("Expected a listing array, listings[], candidates[], items[], or a price-band mainstream_pool[].")

    title = args.title or (str(in_title) if in_title else "Stage-2 Visual Peer Contact Sheet")
    summary = render_contact_sheet(
        items,
        Path(args.output).resolve(),
        title=title,
        cols=args.cols,
        rows=args.rows,
        cell_width=args.cell_width,
        cell_height=args.cell_height,
        base_dir=in_path.parent,
        offline=args.offline,
        timeout=args.timeout,
    )
    if args.manifest_out:
        m_path = Path(args.manifest_out).resolve()
        m_path.parent.mkdir(parents=True, exist_ok=True)
        m_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Emit compact ASCII-safe JSON summary to stdout (without raw local username paths).
    stdout_summary = {k: v for k, v in summary.items() if k != "output_path"}
    stdout_summary["output_name"] = Path(summary["output_path"]).name
    sys.stdout.write(json.dumps(stdout_summary, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as exc:
        sys.stderr.write(f"render_contact_sheet.py failed: {exc}\n")
        raise SystemExit(2)
    except OSError as exc:
        err_name = type(exc).__name__
        sys.stderr.write(f"render_contact_sheet.py failed ({err_name}): I/O error.\n")
        raise SystemExit(2)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"render_contact_sheet.py failed ({type(exc).__name__}).\n")
        raise SystemExit(2)
