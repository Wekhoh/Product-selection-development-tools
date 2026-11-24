// Self-contained, script-free Chinese cards for an already scored local batch.
// Preserves exact byte-for-byte legacy HTML for frozen revisions < 57, the frozen
// revision 57 workbench, and the curatorial studio gallery architecture for revision 58+.

import { sanitizeDiagnosticText } from './contracts.mjs';
import { ledgerMeetsMarginFloor } from './economics.mjs';
import { extractNewcomerReviewOriginBreakdown } from './observations.mjs';
import { R58_FONT_FACE_CSS } from './report-fonts.mjs';
import { verifySavedCodexReceipt } from './openai/codex-runner.mjs';

const GROUP_LABELS = {
  profit: '盈利能力', suggested_bid_pressure: '建议竞价压力', niche_demand: '需求依据',
  market_entry: '竞争分散程度', normal_newcomer: '正常起步新品', need_fit: '需求满足与轻改进',
  product_risk_and_operations: '产品风险与日常工作', rights_and_requirements: '权利与准入',
};
const ITEM_LABELS = {
  refund_adjusted_pre_ad_margin: '退款调整后广告前毛利率', unit_contribution: '单件贡献金额',
  relevant_purchase_entry_bid: '主要购买入口建议竞价', purchase_demand_scale: '相关市场购买规模',
  supported_opportunity: '有依据的需求机会', purchase_entry_match: '购买入口匹配',
  product_dispersion: '产品分散程度', brand_dispersion: '品牌分散程度', seller_dispersion: '可观察卖家分散程度',
  new_product_count_share: '原生市场新品数量占比', new_product_sales_share: '原生市场新品销量占比',
  low_rating_sales_performance: '少评价销售表现', natural_visibility_development: '固定示例自然曝光',
  existing_solution_fit: '现成方案满足需求', feasible_light_differentiation: '可行轻改进',
  low_return_preference: '低退货偏好', storage_tolerance: '储存耐受', transport_tolerance: '运输耐受',
  routine_complexity: '日常工作简洁度', specific_design_rights: '具体款式权利初查', applicable_public_requirements: '适用公开准入要求',
};
const QUEUES = { comparable: '完整可比', pending: '待补证', deferred: '本期暂缓', excluded: '当前规格排除', seasonal_review: '分季评估' };
const STATES = { pass: '通过此项', fail: '不满足', pending: '待补证', defer: '本期暂缓' };
const MEMBER_STATES = {
  qualified: '纳入参照', excluded: '排除参照', pending: '待核实', auxiliary: '辅助观察', duplicate: '已去重',
  unsampled_stratified: '分层未抽样', ramp_up_zero_sales: '未满30天零销量（起量前排除）',
};
const QUALIFIERS = {
  low_return_preference: '这是对应类目的退货率代理，不是本产品的实测退货率；损失金额只在费用中计算一次。',
  storage_tolerance: '这是当前材料、结构和储存证据支持的初步判断，不是储存试验保证。',
  transport_tolerance: '尺寸重量用于费用估算，不能证明防护效果；本项需要结构及包装证据，不代表已完成运输或跌落试验。',
  routine_complexity: '这是有据的日常工作量初步判断，不是未来客服工时实测，也不重复扣除费用。',
  existing_solution_fit: '评价当前具体方案的有据性能；尚未实现的未来改进不当作现有性能。',
  specific_design_rights: '初查结论有范围与时效限制；有据初查不等于完整权利清理，已确认冲突只排除当前规格。',
  applicable_public_requirements: '这里评价已知准入路径负担，不代表未来供应产品已经检测或合规。',
};
const REASONS = new Map([
  ['A completed current-category query and aligned all-age sales reference are required.', '需要完成当前相关类目查询，并提供同口径的全龄商品销量参照。'],
  ['All-age reference families need unique identities and supported sales, including real zeros.', '销量参照须按家族去重并补齐数据；真实零保留，未知不填零。'],
  ['An unresolved observed newcomer could change the selected examples.', '仍有已发现新品可能改变固定示例，需要完成它的评价数、销量或起步核查。'],
  ['The fixed current-category examples lack supported SIF overall shares.', '固定示例仍缺SIF整体自然曝光占比，不能换一款有数据的来顶替。'],
  ['A positive category sales reference is required for positive sales.', '销量为正，但类目销量参照尚不能支持比较。'],
  ['A qualified current example needs matching rank 1-100 and a supported launch within three calendar months.', '新品需要对应当前榜单前100名，并有近三个月起步证据；当前记录不满足或待核。'],
  ['The rubric judgment is unavailable and needs evidence.', '该判断尚缺证据。'],
  ['Judgment does not name an adopted rubric anchor.', '提供的判断档位不属于本项已确认档位。'],
  ['Observation is missing.', '尚未取得这项数据。'],
  ['Observation is outside its valid numeric domain.', '输入不在有效数值范围内。'],
  ['Observation has unresolved support or conflict.', '这项观察尚未得到支持，或仍有实质冲突。'],
  ['Observation needs valid source/date evidence references and a concrete form.', '缺少有效来源、日期或具体可售规格。'],
  ['Required metric scope, period or applicability is unsupported.', '指标的市场范围、观察期间或适用性尚不明确。'],
  ['Demand bounds need one supported coherent population and an explained range, without a competing point.', '需求范围须对应同一有据样本，并说明上下限依据；不能同时混填单点或倒序区间。'],
  ['A bounded judgment needs a reason and valid evidence references.', '该判断需要具体理由和有效证据。'],
  ['A common saleable unit and nonempty supported economic scenario set are required.', '尚缺统一可售单位下的费用情景。'],
  ['Economic scenarios need unique IDs, the same saleable unit, coherent inputs and explicit assumptions.', '费用情景的规格、可售单位、假设或编号存在未解决的问题。'],
  ['Supported margin and contribution have contradictory signs or zero under the required positive net revenue.', '同一费用记录中的毛利率与贡献金额正负号或零值矛盾，不能作为完整利润证据。'],
  ['One or more economic scenarios lacks a supported complete margin; missing costs are not zero.', '至少一个情景尚不能支持完整毛利；请核对未决费用或情景假设，缺失项不当零。'],
  ['The supported margin upper bound is below the existing 30% floor.', '有据毛利率上界仍低于30%，当前规格不满足毛利条件。'],
  ['Even before adding unconfirmed nonnegative domestic freight, the supported bare-goods margin upper bound is below the existing 30% floor.', '即便尚未计入非负国内运费，仅按已核裸货与平台费用计算的毛利上界仍低于既有30%门槛。'],
  ['The supported scenario margin is below the existing 30% floor.', '该有据情景的毛利率低于30%，不满足毛利条件。'],
  ['All supported coherent scenarios meet the margin condition.', '所有有据且一致的情景均满足毛利条件。'],
  ['The supported margin range crosses 30%; screening remains pending.', '毛利区间跨过30%，需要补证后判断。'],
  ['Every coherent eligible scenario needs supported nonnegative unit contribution.', '每个合格费用情景都需要有据的非负单件贡献金额。'],
  ['A supported positive matched-spec reference price is required.', '尚缺同规格、正数且有据的参考售价。'],
  ['Supported matched-spec reference price is above USD 30.', '有据同规格参考价高于30美元。'],
  ['Supported matched-spec reference price does not exceed USD 30.', '有据同规格参考价未超过30美元。'],
  ['Supported matched-spec reference price is at least USD 29.99.', '有据同规格参考价不低于29.99美元。'],
  ['Supported matched-spec reference price is below USD 29.99.', '有据同规格参考价低于29.99美元。'],
  ['Strong date dependency has not been assessed with supported evidence.', '尚未有据判断是否强依赖节日或特定日期。'],
  ['The supported strong holiday/date dependency is deferred in this reference profile.', '强依赖节日或日期，本期参考方案暂缓。'],
  ['No strong holiday/date dependency is identified in the supported initial check.', '有据初查未发现强节日或日期依赖。'],
  ['A supported current/latest-30-day comparable normal-newcomer reference is required.', '尚缺当前评分数量与兼容近30天销量的正常新品参照。'],
  ['No supported qualified normal-newcomer reference member is available.', '没有可用的、有据合格的正常新品参照。'],
  ['One complete example is single-case evidence, not a direction score.', '目前只有一个完整示例，保留单例观察，不构成方向得分。'],
  ['Two complete qualified examples require supported full-cohort rating and positive sales references.', '两个完整示例还需要全体合格样本的评分数量和正销量中位数。'],
  ['The fixed low-rating pair lacks supported SIF overall share evidence for one or both members.', '固定示例对中至少一项仍缺有据的SIF整体自然曝光占比。'],
  ['Every selected entry needs supported monthly volume and the total must be positive.', '每个主购买入口都需要有据月搜索量，合计必须为正。'],
  ['A required main-entry native exact point is missing from both usable sources.', '某个主购买入口在两个可用来源中都缺原生精确竞价点值。'],
  ['Main-entry queries must be nonempty and deduplicated before scoring.', '主购买入口需要先去重，并补齐空查询。'],
  ['A supported main-entry set with common monthly volume and US/exact/USD scope is required.', '需要有据的美国站主购买入口、同周期月搜索量及美元精确匹配竞价。'],
  ['A supported main-entry set with US/exact/USD scope is required.', '需要有据的美国站主购买入口及美元精确匹配竞价。'],
  ['Supplied monthly volumes need a declared common period.', '已提供的月搜索量需要注明共同统计期间。'],
  ['Supplied monthly volumes need valid compatible evidence and a positive total; equal weighting only resolves missing volume.', '已提供的月搜索量有口径、证据或零合计问题，须核实；等权只解决月搜索量缺失。'],
  ['A supported opportunity needs one adopted strongest route.', '需求机会判断需要说明证据最强的已确认路径。'],
  ['One relevant source-native report with compatible population, period and basis is required.', '需要同一个相关原生报告，并明确样本、期间和统计口径。'],
  ['Native newcomer shares require the same three-month report and latest-30-day unit window.', '原生新品占比需要使用同一个三个月新品报告及近30天件数窗口。'],
  ['A supplied native ratio denominator must be supported and positive; zero or unknown is not a zero share.', '已提供的占比分母需要有据且为正；零分母或未知分母不等于零占比。'],
  ['Missing or incompatible exact-match strategy, currency or marketplace.', '缺少或不兼容的精确匹配策略、币种或站点。'],
  ['Entry volume does not use the declared common period.', '该入口搜索量与所声明的共同统计期间不一致。'],
  ['The weighted bid reference is not finite.', '加权竞价结果不是有效有限数值。'],
  ['A SIF overall share needs identified period, subject and relevant-entry evidence.', 'SIF整体占比还需要明确观察期、产品范围和相关购买入口证据。'],
  ['A qualified member needs frozen family/listing identity and qualification evidence.', '合格参照需要固定的家族／商品身份和资格证据。'],
  ['The asserted old-review conflict lacks valid evidence references.', '关于旧评价冲突的判断仍缺有效证据引用。'],
  ['Supported old reviews predate the purported recent launch; excluded from the normal-start reference.', '有据旧评价早于所称近期上架时间，排除正常起步参照；不据此认定具体操作原因。'],
  ['Qualified identity, grouping or duplicate observations remain unresolved.', '合格参照的身份、归组或重复观察仍未解决。'],
  ['Duplicated family/shared-launch records have incompatible current observations.', '同家族或共享起步记录的当前观察互不兼容。'],
  ['True-zero rating median leaves the relative component unscored.', '真实评分数量中位数为零，相对数量分保持未评分。'],
  ['True-zero sales median supplies no sales ratio.', '真实销量中位数为零，不能计算销量比值。'],
  ['A verified non-empty all-age sales reference T is required; missing T cannot default to 10.', '需要有据且非空的全龄销量参照中位数 T；缺失 T 时保持待补证，不自动按 10 件保底。'],
  ['All-age reference families need unique identities and supported sales, including real zeros; missing T stays pending.', '全龄销量参照家族须身份唯一且销量齐全（保留真实零）；缺失 T 保持待补证。'],
  ['Unresolved or invalid newcomer observations remain pending and block Q31 scoring.', '仍有未决或无效的新品记录，阻断 Q31 计分。'],
  ['Stratified sampling (unsampled_stratified) is only permitted when N_active > 5.', '仅在有效同任务新品池 N_active > 5 时才允许使用分层未抽样状态。'],
  ['Qualified representatives do not match the deterministic 5-quintile stratified selection and replacement order.', '已核新品代表与确定性 5 分位分层抽样及替补顺序不符，阻断择优挑选。'],
  ['unsampled_stratified requires reliable ratings and units_30d inputs; missing inputs remain blocking.', '分层未抽样候选必须具备可靠的评价数与 30 天销量字段；缺字段项仍阻断。'],
  ['Only verified <30-day zero-sales listings may be pre-excluded as ramp_up_zero_sales.', '仅已核未满 30 天且零销量的记录可作为起量前零销量排除。'],
  ['Flat annual mode requires every primary scenario to cover all 12 calendar months and all days of one target year (YYYY-01-01..YYYY-12-31).', '全年模式要求每个主情景覆盖同一目标年份完整 12 个自然月及全部日期（YYYY-01-01 至 YYYY-12-31）。'],
]);

const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const safeText = value => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try { return String(value); } catch { try { return JSON.stringify(value) ?? ''; } catch { return ''; } }
};
const escape = value => safeText(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const numberText = value => finite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : '未知';
const rangeText = range => Array.isArray(range) && range.length === 2 && range.every(finite) ?
  range[0] === range[1] ? numberText(range[0]) : `${numberText(range[0])}–${numberText(range[1])}` : '未知';
const reasonText = value => REASONS.get(value) ?? string(value, '证据尚待补齐。');

function readable(value, depth = 0) {
  if (value === null || value === undefined) return '未知';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  if (finite(value)) return numberText(value);
  if (depth > 2) return '详见原始记录';
  if (Array.isArray(value)) return value.map(item => readable(item, depth + 1)).join('；');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}：${readable(item, depth + 1)}`).join('；');
  return '未知';
}

const isR57 = value => (value?.profile_revision ?? 0) >= 57;
const isR58 = value => (value?.profile_revision ?? 0) >= 58;

function sanitizeLocalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '未知';
  let normalized = value.trim();
  if (/^file:\//i.test(normalized)) {
    normalized = normalized.replace(/^file:\/\/(?!\/|localhost(?:\/|$))([^/]+)\//i, '//$1/')
      .replace(/^file:\/+(?:localhost\/)?/i, '/');
    try { normalized = decodeURIComponent(normalized); } catch {}
  }
  normalized = normalized.replace(/\\/g, '/');
  normalized = normalized.replace(/^(?:\/+)?\?\/UNC\//i, '//').replace(/^(?:\/+)?[?.]\//, '');
  normalized = normalized.startsWith('//') ? `//${normalized.slice(2).replace(/\/+/g, '/')}` : normalized.replace(/\/+/g, '/');
  normalized = normalized.replace(/^\/+(?=[A-Za-z]:\/)/, '');
  const marker = normalized.match(/(?:^|\/)(\.local\/.*|docs\/.*|fixtures\/.*|src\/.*|test\/.*|data\/.*|outputs\/.*)$/i);
  if (marker) return marker[1];
  return normalized
    .replace(/(?:^[A-Za-z]:|^\/\/[^/]+(?:\/[^/]+)?|^\/mnt\/[a-z]|^)\/(?:Users|Documents and Settings|home)\/[^/]+(?=\/|$)/i, '~')
    .replace(/\/(Users|Documents and Settings|home)\/[^/]+(?=\/|$)/gi, '/~');
}

function decodeRepeated(str, maxRounds = 4) {
  let cur = str;
  for (let i = 0; i < maxRounds; i++) {
    let next;
    try { next = decodeURIComponent(cur); } catch { break; }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function sanitizeHttpUrlParams(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return urlStr;
    let changed = false;
    const entries = [...u.searchParams.entries()];
    if (entries.length) {
      const next = new URLSearchParams();
      for (const [k, v] of entries) {
        const dk = decodeRepeated(k);
        const dv = decodeRepeated(v);
        const sk = sanitizeTextPaths(dk);
        const sv = sanitizeTextPaths(dv);
        if (sk !== dk || sv !== dv) {
          changed = true;
          next.append(sk !== dk ? sk : k, sv !== dv ? sv : v);
        } else {
          next.append(k, v);
        }
      }
      if (changed) u.search = next.toString();
    }
    if (u.hash && u.hash.length > 1) {
      const decodedHash = decodeRepeated(u.hash.slice(1));
      const cleanHash = sanitizeTextPaths(decodedHash);
      if (cleanHash !== decodedHash) {
        u.hash = encodeURIComponent(cleanHash);
        changed = true;
      }
    }
    return changed ? u.href : urlStr;
  } catch {
    return urlStr;
  }
}

function redactQuotedUserPaths(str) {
  const userPrefixRe = /^(?:file:\/+(?:[^/\s\r\n"<>]+\/){0,5}|(?:(?:\\\\|\/\/)\?[\\/]UNC[\\/]+[^\\/\s:;\r\n"|?*<>]+[\\/]+(?:[^\\/\s:;\r\n"|?*<>]+[\\/]+)?|(?:(?:\\\\|\/\/)[?.][\\/]+)?[A-Za-z]:[\\/]+|(?:\\\\|\/\/)[^\\/\s:;\r\n"|?*<>]+[\\/]+(?:[^\\/\s:;\r\n"|?*<>]+[\\/]+)?)|\/(?:mnt\/[a-z]\/)?)(?:Users|Documents and Settings|home)[\\/]+/i;
  const out = str.replace(/"([^"\r\n]+)"/g, (full, inner) => (
    userPrefixRe.test(inner) ? `"${sanitizeLocalPath(inner)}"` : full
  ));
  let result = '';
  let i = 0;
  while (i < out.length) {
    if (out[i] === "'") {
      const rest = out.slice(i + 1);
      if (userPrefixRe.test(rest)) {
        let j = i + 1;
        let closeIdx = -1;
        while (j < out.length && out[j] !== '\r' && out[j] !== '\n') {
          if (out[j] === "'") {
            const nextCh = out[j + 1] ?? '';
            if (nextCh && /[A-Za-z0-9_\\/-]/.test(nextCh)) {
              j++;
              continue;
            }
            if (nextCh === ' ') {
              const rem = out.slice(j + 1);
              const clauseEnd = rem.search(/[\r\n,;。)）\]]/);
              const clause = clauseEnd >= 0 ? rem.slice(0, clauseEnd) : rem;
              const nextQ = clause.indexOf("'");
              const afterNextQ = clause[nextQ + 1] ?? '';
              if (nextQ > 0 && !/\s/.test(clause[nextQ - 1]) && (!afterNextQ || !/[A-Za-z0-9_\\/-]/.test(afterNextQ))) {
                j++;
                continue;
              }
            }
            closeIdx = j;
            break;
          }
          j++;
        }
        if (closeIdx > i + 1) {
          const inner = out.slice(i + 1, closeIdx);
          result += `'${sanitizeLocalPath(inner)}'`;
          i = closeIdx + 1;
          continue;
        }
      }
    }
    result += out[i];
    i++;
  }
  return result;
}

function sanitizeTextPaths(value) {
  if (typeof value !== 'string' || !value) return '';
  const trimmed = value.trim();
  if (/^(?:file:\/|[A-Za-z]:[\\/]|\\\\|\/\/|\/(?:Users|Documents and Settings|home|mnt)\/)/i.test(trimmed) && !/\s/.test(trimmed)) {
    return sanitizeLocalPath(trimmed);
  }
  const winUserRoot = String.raw`(?:(?:\\\\|\/\/)\?[\\/]UNC[\\/]+[^\\/\s:;\r\n"|?*<>]+[\\/]+(?:[^\\/\s:;\r\n"|?*<>]+[\\/]+)?|(?:(?:\\\\|\/\/)[?.][\\/]+)?[A-Za-z]:[\\/]+|(?:\\\\|\/\/)[^\\/\s:;\r\n"|?*<>]+[\\/]+(?:[^\\/\s:;\r\n"|?*<>]+[\\/]+)?)`;
  const userSegBeforeSlash = String.raw`[^\\/:;\r\n"|?*<>]+`;
  const userSegNoSlash = String.raw`(?:[^\\/\s:;\r\n"|?*<>)']|'(?=\S))+`;
  const reFileUser = new RegExp(String.raw`file:\/+(?:[^/\s\r\n"<>]+\/){0,5}(?:Users|Documents and Settings|home)\/${userSegBeforeSlash}(?=\/)`, 'gi');
  const reWinSlash = new RegExp(String.raw`${winUserRoot}(?:Users|Documents and Settings)[\\/]+${userSegBeforeSlash}(?=[\\/])`, 'gi');
  const reUnixSlash = new RegExp(String.raw`(?<![A-Za-z0-9._-])\/(?:mnt\/[a-z]\/)?(?:Users|home)\/${userSegBeforeSlash}(?=\/)`, 'gi');
  const reWinNoSlash = new RegExp(String.raw`${winUserRoot}(?:Users|Documents and Settings)[\\/]+${userSegNoSlash}`, 'gi');
  const reUnixNoSlash = new RegExp(String.raw`(?<![A-Za-z0-9._-])\/(?:mnt\/[a-z]\/)?(?:Users|home)\/${userSegNoSlash}`, 'gi');
  return redactQuotedUserPaths(
    value.replace(/https?:\/\/[^\s"<>]+/gi, match => {
      const m = match.match(/^(.*?)([',;。)）\]]*)$/);
      return sanitizeHttpUrlParams(m[1]) + m[2];
    }),
  )
    .replace(reFileUser, match => sanitizeLocalPath(match))
    .replace(/file:\/\/(?:[^\s;)"<>']|'(?!\s|[，。；,;)）\]}]))+/gi, match => sanitizeLocalPath(match))
    .replace(reWinSlash, match => sanitizeLocalPath(match))
    .replace(reUnixSlash, match => sanitizeLocalPath(match))
    .replace(reWinNoSlash, match => sanitizeLocalPath(match))
    .replace(reUnixNoSlash, match => sanitizeLocalPath(match));
}

function isAllowedRootImageKey(keyName) {
  return keyName === 'image_data_uri' || keyName === 'contact_sheet_data_uri' || keyName === 'hero_image_data_uri';
}

function sanitizeDisplayTree(value, keyName = '', allowRootImageUri = false) {
  if (allowRootImageUri && isAllowedRootImageKey(keyName) && imageUri(value) !== null) return value;
  if (typeof value === 'string') {
    if ((keyName === 'url' || keyName === 'href') && safeHttpUrl(value)) return sanitizeHttpUrlParams(value);
    return sanitizeTextPaths(value);
  }
  if (Array.isArray(value)) return value.map(item => sanitizeDisplayTree(item, '', false));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[sanitizeTextPaths(k)] = sanitizeDisplayTree(v, k, allowRootImageUri && isAllowedRootImageKey(k));
    }
    return out;
  }
  return value;
}

const isScoredSupportedR58 = sc => sc?.coherence_supported === true &&
  sc?.input?.calculation?.scoring_supported === true &&
  sc?.input?.calculation?.status !== 'sensitivity_only';

function readableSanitized(value, depth = 0) {
  if (value === null || value === undefined) return '未知';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return sanitizeTextPaths(value);
  if (finite(value)) return numberText(value);
  if (depth > 2) return '详见原始记录';
  if (Array.isArray(value)) return value.map(item => readableSanitized(item, depth + 1)).join('；');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${sanitizeTextPaths(key)}：${readableSanitized(item, depth + 1)}`).join('；');
  return '未知';
}

export function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function sourceLink(label, value) {
  const url = safeHttpUrl(value);
  return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escape(label)}</a>` : escape(label);
}

function imageUri(value) {
  if (typeof value !== 'string' || value.length > 12_000_000) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) return null;
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return valid ? value : null;
}

function observed(input) {
  if (!input || input.value === null || input.value === undefined) return '未知';
  if (input.unit === 'fraction' && finite(input.value)) return `${numberText(input.value * 100)}%`;
  if (input.unit === 'USD' && finite(input.value)) return `US$ ${numberText(input.value)}`;
  return readable(input.value);
}

const COST_LABELS = { procurement: '采购（含约定普通包装）', domestic_freight: '国内运费分摊', headhaul: '头程（含适用 bond）',
  referral: '退款调整后净佣金', fulfillment: 'FBA原出库配送', placement: '入库配置', storage: '仓储分摊',
  returns_processing: '额外退货处理', returns_disposal: '退货损失／处置', collection: '收款手续费',
  other_applicable: '其他适用费用', recovery_credit: '回收抵扣' };

const FEE_ISSUES = {
  missing_fee_context: '缺少有效的美国站、美元、包装参照或销售／仓储／入库日期。',
  operating_period_mismatch: '销售日期超出了卡片列出的经营月份。',
  missing_cost_evidence: '缺少已登记的成本来源。',
  domestic_quote_required: '需要100采购单位的国内运费报价，不能沿用旧暂缓规则。',
  missing_components: '尚未说明这笔费用已包含哪些收费项目。',
  duplicate_component: '与其他成本行重复包含同一收费项目，须核对后再算。',
  unpublished_fee: '没有可用的已发布适用费率；不拿其他年份或季节的费率代替。',
  invalid_fee_basis: '费率版本、来源或生效日期不完整。',
  fee_scope_mismatch: '费率的站点、币种或包装参照不一致。',
  fee_outside_dates: '该费率没有覆盖完整目标日期，请核对下方版本。',
  fee_season_mismatch: '该费率没有覆盖目标月份，或月份输入无效。',
  returns_processing_required: '实物退货率高于类目阈值且无官方豁免，必须计入额外退货处理费。',
  invalid_return_rate: '实物退货率超出有效范围 [0, 1)。',
  missing_carrier_bond: '修订58要求正头程报价在 headhaul.components 中明确包含适用 carrier_bond（或提供有据豁免声明），不能默认已含。',
};

function inputSummary(item, rev = 0) {
  const input = object(item.input);
  if (Array.isArray(item.scenario_scores)) return item.scenario_scores.map(row => `${row.id}：${item.id === 'refund_adjusted_pre_ad_margin' ? `${numberText(row.value * 100)}%` : `US$ ${numberText(row.value)}`}`).join('；');
  if (item.id === 'relevant_purchase_entry_bid') return item.aggregation_method === 'single_main_entry'
    ? '一个真实主购买词：直接使用该词的可用精确竞价点；两源都有时先取均值，原始区间另列。'
    : item.aggregation_method === 'equal_main_entries'
      ? '每个主购买词都有可用精确竞价，仅缺月搜索量：先合并各词来源，再对全部主购买词等权平均；原始区间另列。'
      : item.aggregation_method === null
        ? '主购买词证据待补齐；不能只平均有报价的词，也不能把无效数据当作缺失量使用等权。'
        : '主购买入口先取两源可用精确竞价点，再按同周期月搜索量加权；原始区间另列。';
  if (item.id === 'low_rating_sales_performance') {
    if (rev >= 58) return '同任务满30天正常新品强制纳入，未满30天有销新品按精确有理数贪心择优并入使 F(S)=sum(e)/max(|S|,2) 严格提高；具体样本见下方。';
    return input.scope === 'current_relevant_bsr_top100' ? '评价数量得分受独立类目销量参照限制，再取至多两个最佳完整示例；具体依据见下方。' : '全体合格参照计算中位数，再取完整示例的前两名；具体样本见下方。';
  }
  if (item.id === 'natural_visibility_development') {
    if (rev >= 58) return '固定使用少评价销售表现选定的同一组样本 S* 与同一分母 D，采用 SIF 近30天整体自然曝光占比，不因数据易得而换例。';
    return '固定使用少评价销售表现选定的示例，不因自然占比或数据更容易获得而换例。';
  }
  if (['refund_adjusted_pre_ad_margin', 'unit_contribution'].includes(item.id)) return item.status === 'ineligible' ? '费用已算出，但该方案不满足毛利条件；具体金额见费用情景。' : '完整情景尚待补证，已有金额和缺口见费用情景。';
  if (Object.hasOwn(input, 'anchor')) return input.anchor === null ? '判断档位：待补证' : `采用有据档位 ${readable(input.anchor)} / ${item.weight}`;
  if (item.id === 'purchase_demand_scale' && Array.isArray(input.value_range)) {
    const scope = ['niche', 'period'].map(key => string(input[key])).filter(Boolean).join('；');
    return `输入范围：${rangeText(input.value_range)}${input.unit === 'units' ? ' 件' : ''}；${string(input.range_basis, '范围依据待补证')}${scope ? `；${scope}` : ''}`;
  }
  if (Object.hasOwn(input, 'value')) {
    const scope = ['niche', 'category', 'period'].map(key => string(input[key])).filter(Boolean).join('；');
    return `输入：${observed(input)}${scope ? `；${scope}` : ''}`;
  }
  return '该项输入尚未完整提供。';
}

function evidenceLinks(refs, registry, prefix) {
  if (!array(refs).length) return '<span class="muted">暂无可核验引用</span>';
  return array(refs).map(ref => {
    const index = registry.findIndex(entry => entry?.id === ref);
    const label = index >= 0 ? string(registry[index].source, string(ref, '证据')) : readable(ref);
    return index >= 0 ? `<a href="#${prefix}-e${index}">${escape(label)} [${index + 1}]</a>` : `<span>${escape(label)}（引用待核实）</span>`;
  }).join(' · ');
}

// ============================================================================
// Legacy Frozen Renderer (revisions < 57: byte-for-byte historical parity)
// ============================================================================
function legacyPresentationRows(title, value) {
  const rows = array(value).filter(row => row && typeof row === 'object' && !Array.isArray(row));
  if (!rows.length) return '';
  return `<section class="support-section"><h3>${escape(title)}</h3><dl class="reference-rows">${rows.map(row => {
    const label = string(row.label, '补充记录');
    const main = `${readable(row.value)}${typeof row.unit === 'string' ? ` ${row.unit}` : ''}`;
    const note = string(row.note);
    const source = string(row.source);
    return `<div><dt>${escape(label)}</dt><dd>${escape(main)}${note ? `<p class="muted">${escape(note)}</p>` : ''}${source || safeHttpUrl(row.url) ? `<p class="source">来源：${sourceLink(source || '查看来源', row.url)}</p>` : ''}</dd></div>`;
  }).join('')}</dl></section>`;
}

function legacyBidDetails(item) {
  if (!array(item.entries).length) return '';
  const single = item.aggregation_method === 'single_main_entry';
  const equal = item.aggregation_method === 'equal_main_entries';
  return `<div class="item-support"><p><strong>原始精确竞价</strong>：${item.reference_bid_usd === null ? '点值参考待补证' : `${single ? '单个主购买词直接参考' : equal ? '主购买词等权参考' : '主入口加权参考'} US$ ${escape(numberText(item.reference_bid_usd))}`}</p>
    ${single ? '<p class="muted">输入研究记录声明只有一个真实主购买词；本项不需要月搜索量，缺失时保留未知，也不据此推断市场规模。</p>' : ''}
    ${equal ? '<p class="muted">缺少月搜索量；每个主要购买词的可用精准报价均已齐全，因此先合并各词的来源报价，再对全部主购买词等权平均。缺失量保留未知，等权不代表各词需求相同。</p>' : ''}
    ${item.entries.map(entry => `<div class="bid-entry"><p><strong>${escape(entry.query)}</strong> · 月搜索量 ${escape(numberText(entry.volume))} · 两源可用点均值 ${entry.combined_point === null ? '未知' : `US$ ${escape(numberText(entry.combined_point))}`}</p><ul>${['sellersprite', 'sif'].map(source => {
      const reading = object(entry.sources?.[source]);
      const label = source === 'sif' ? 'SIF 固定／精确' : 'SellerSprite 精确';
      return `<li>${label}：${reading.point === null || reading.point === undefined ? '点值未知' : `US$ ${escape(numberText(reading.point))}`}；原始区间 ${reading.range ? `US$ ${escape(rangeText(reading.range))}` : '未提供可用区间'}${reading.strategy === 'unspecified' ? '；策略未说明，作为近似试评输入' : ''}${reading.point === null && reading.reason ? `；${escape(reasonText(reading.reason))}` : ''}</li>`;
    }).join('')}</ul></div>`).join('')}
    ${Object.entries(object(item.range_scenarios)).filter(([, scenario]) => scenario).map(([source, scenario]) => `<p class="muted">${source === 'sif' ? 'SIF' : 'SellerSprite'}来源区间情景：${single ? '原始建议竞价' : equal ? '等权建议竞价' : '加权建议竞价'} US$ ${escape(rangeText(scenario.bid_range_usd))}，对应评分 ${escape(rangeText(scenario.score_range))}。此区间不替代主点值，不是实际CPC预测。</p>`).join('')}</div>`;
}

function legacyNewcomerDetails(result) {
  const diagnostics = object(result.diagnostics?.newcomers);
  const pair = array(diagnostics.selected_pair);
  const examples = array(diagnostics.examples);
  const members = array(diagnostics.members);
  const refs = object(diagnostics.references);
  const current = ['current_category_r51', 'current_category_r52', 'current_category_r53', 'current_category_r54', 'current_category_r55', 'current_category_r56'].includes(diagnostics.reference_mode);
  const pairKeys = new Set(pair.map(entry => `${entry.family_id}\0${entry.asin}`));
  return `<section class="support-section"><h3>正常新品：${current ? '固定示例' : '同一对示例'}</h3>
    <p>${current ? diagnostics.no_qualifying_examples ? '当前相关榜单的完整查询中，没有合格近三个月新品；少评价与自然曝光各记0支持分，不代表无法进入此市场。' : `独立类目参照：${escape(numberText(refs.family_count))}个去重家族，近30天销量中位数 ${escape(numberText(refs.sales_median))} 件。参照包含新老商品；不再计算评价数中位数。销量粒度：${refs.grain === 'family_representative' ? '每家族一个代表ASIN估算，不是父体合计' : '声明的家族销量'}。` : `评分数量中位数 ${escape(numberText(refs.rating_median))}；近30天销量中位数 ${escape(numberText(refs.sales_median))}。中位数使用全体观察到的合格参照，包含弱表现与仍合格的退出样本。`}</p>
    <p>${pair.length ? `固定${pair.length}个示例：${pair.map(entry => escape(`${entry.family_id} / ${entry.asin}`)).join('；')}。${pair.length === 1 ? '这是单例支持，不能理解为普遍成功。' : ''}` : diagnostics.no_qualifying_examples ? '保留源样本及排除理由。' : '示例尚待核实；缺数据不填零。'}</p>
    ${diagnostics.selection_tie_policy === 'complete_score_before_unresolved_equal_bound' ? '<p class="muted">已有两款完整少评价得分时，最多只能同分的缺数样本不再阻断选例；缺数仍是未知。可能超过所选样本的仍需补证。自然可见度继续使用同一组示例。</p>' : ''}
    ${examples.length ? `<dl class="reference-rows">${examples.map(example => {
      const raw = members.find(member => member?.family_id === example.family_id && member?.asin === example.asin) ?? {};
      const natural = object(example.natural);
      return `<div><dt>${escape(example.family_id)}${pairKeys.has(`${example.family_id}\0${example.asin}`) ? ' · 已选示例' : ' · 参照样本'}</dt><dd>评分数量 ${escape(observed(raw.ratings))}；近30天销量 ${escape(observed(raw.units_30d))}；少评价示例得分 ${escape(numberText(example.score))} / 4。<p class="muted">实际数量分 ${escape(numberText(example.actual_score))}；${current ? '' : `相对数量分 ${escape(numberText(example.relative_score))}；`}销量／参照中位数 ${escape(numberText(example.sales_ratio))}；销量封顶 ${escape(numberText(example.sales_ceiling))}。</p>${typeof raw.reason === 'string' ? `<p class="muted">纳入理由：${escape(raw.reason)}</p>` : ''}<p>自然曝光 ${escape(observed(natural.input))}；${natural.source_label === 'sif_with_sellersprite_corroboration' ? 'SIF占比，附SellerSprite关键词旁证' : 'SIF单来源占比'}。${natural.score === null || natural.score === undefined ? escape(reasonText(natural.reason)) : `自然示例得分 ${escape(numberText(natural.score))} / 1。`}${natural.input?.period ? `观察期：${escape(readable(natural.input.period))}。` : ''}</p>${natural.keyword_counts ? `<p class="muted">自然／广告关键词数：SellerSprite ${escape(numberText(natural.keyword_counts.sellersprite?.organic))} / ${escape(numberText(natural.keyword_counts.sellersprite?.ad))}；SIF ${escape(numberText(natural.keyword_counts.sif?.organic))} / ${escape(numberText(natural.keyword_counts.sif?.ad))}。</p>` : ''}</dd></div>`;
    }).join('')}</dl>` : ''}
    ${members.some(member => member?.effective_status && member.effective_status !== 'qualified') ? `<ul>${members.filter(member => member?.effective_status && member.effective_status !== 'qualified').map(member => `<li>${escape(member.family_id ?? member.asin ?? '未命名记录')}：${escape(MEMBER_STATES[member.effective_status] ?? member.effective_status)}；${escape(reasonText(member.reason))}</li>`).join('')}</ul>` : ''}
    <p class="muted">自然占比是来源建模的曝光构成，不是自然订单或利润。关键词数仅作旁证，不换算曝光占比，也不额外加分。原生市场新品3／2分与上述合格示例4／1分保持分开。</p></section>`;
}

function legacyFeeLedgerDetails(scenario) {
  const ledger = scenario.input?.calculation;
  if (!ledger) return '';
  const validation = object(ledger.fee_validation), context = object(validation.context);
  const windowText = window => window ? `${window.from} 至 ${window.through}` : '待补证';
  const pending = array(ledger.pending_lines), deferred = array(ledger.deferred_lines);
  const rows = array(ledger.lines).map(line => {
    const unknown = pending.includes(line.id) || line.amount_usd === null;
    const basis = line.fee_basis;
    const dateText = basis ? `${basis.version ?? '正式费率待补'}；${basis.effective_from ?? '未知'} 至 ${basis.effective_through ?? '未声明截止日'}${basis.months !== undefined ? `；适用月份 ${Array.isArray(basis.months) ? basis.months.join('、') : '无效，待补证'}` : ''}` : '按所列成本来源与情景';
    return { label: COST_LABELS[line.id] ?? line.id,
      value: deferred.includes(line.id) ? (pending.includes(line.id) ? '旧暂缓规则不再适用，待补证' : '按已批准范围暂缓，金额未知') : unknown ? '待补证' : line.amount_usd,
      unit: !unknown && !deferred.includes(line.id) ? 'USD/销售单位' : '', note: `${line.basis}；${dateText}` };
  });
  return `<section class="support-section fee-validation"><h4>费率适用性：${validation.status === 'validated' ? '所声明日期与来源通过检查' : '存在待补证项'}</h4><p>销售：${escape(windowText(context.sales))}；仓储：${escape(windowText(context.storage))}；入库：${escape(windowText(context.inbound))}。</p><p>净收入 US$ ${escape(numberText(ledger.net_revenue_usd))}；完整费用 ${ledger.net_cost_usd === null ? '未知' : `US$ ${escape(numberText(ledger.net_cost_usd))}`}；完整贡献 ${ledger.net_cost_usd === null ? '未知' : `US$ ${escape(numberText(ledger.contribution_usd))}`}。</p>${array(validation.issues).length ? `<ul>${validation.issues.map(issue => `<li><strong>${escape(COST_LABELS[issue.line] ?? '费用情景')}</strong>：${escape(FEE_ISSUES[issue.code] ?? issue.reason)}</li>`).join('')}</ul>` : ''}${legacyPresentationRows('由本次计算账本生成的费用明细', rows)}<p class="muted">费用按本销售单位计入一次。净佣金已含退款管理费；原出库配送不因退款再扣一次。收款从本情景的Amazon打款估算；待补费用不按零计。日期检查验证已声明的来源范围，不代替源页面核验。</p></section>`;
}

function legacyEconomicDetails(result) {
  const diagnostics = object(result.diagnostics?.economics);
  const scenarios = array(diagnostics.scenarios);
  if (!scenarios.length) return '';
  return `<section class="support-section"><h3>费用情景与假设</h3><p>统一可售单位：${escape(diagnostics.saleable_unit ?? '未知')}。毛利率与单件贡献来自同一情景，不能拼接不同情景的有利端点。</p><dl class="reference-rows">${scenarios.map(scenario => {
    const calculation = scenario.input?.calculation;
    const conditional = calculation?.status === 'sensitivity_only';
    const margin = conditional ? { value: calculation.margin, unit: 'fraction' } : scenario.input?.margin;
    const contribution = conditional ? { value: calculation.contribution_usd, unit: 'USD' } : scenario.input?.contribution_usd;
    const explanation = conditional ? '费用已算出，但售价或其他情景假设尚未确认；不授予经济分。' :
      scenario.coherence_supported === true && scenario.margin_eligible === true ? '该情景满足毛利条件。' :
        calculation && !calculation.scoring_supported ? `完整费用尚待补证：${array(calculation.pending_lines).map(id => COST_LABELS[id] ?? id).join('、') || '费率适用日期或来源'}。见下方核对。` :
          reasonText(scenario.eligibility_reason ?? scenario.margin?.reason ?? '该情景尚不满足或尚不能判断毛利条件。');
    return `<div><dt>${escape(scenario.id ?? '未命名情景')}</dt><dd>${conditional ? '条件试算毛利率' : '广告前毛利率'} ${escape(observed(margin))}；单件贡献 ${escape(observed(contribution))}。<p>${escape(explanation)}</p>${legacyFeeLedgerDetails(scenario)}${array(scenario.input?.assumptions).length ? `<ul>${scenario.input.assumptions.map(value => `<li>${escape(readable(value))}</li>`).join('')}</ul>` : ''}</dd></div>`;
  }).join('')}</dl><p class="muted">缺失费用仍为未知。费用测算、初步路径判断、实际供应验证与后续经营结果分别核验。</p></section>`;
}

function legacyScoreRows(result, registry, prefix) {
  return array(result.groups).map(group => {
    const rows = array(result.items).filter(item => item.group === group.id);
    return `<section class="score-group" data-group-id="${escape(group.id)}"><h3>${escape(GROUP_LABELS[group.id] ?? group.id)}<span>${escape(rangeText(group.supported_range))} 已支持分 · 覆盖 ${escape(numberText(group.covered_weight))} / ${escape(numberText(group.weight))} 权重</span></h3>${rows.map(item => {
      const scored = item.status === 'scored' && Array.isArray(item.score_range);
      return `<div class="item-row" data-item-id="${escape(item.id)}"><div class="item-heading"><h4>${escape(ITEM_LABELS[item.id] ?? item.id)}</h4><p class="item-score">${scored ? `${escape(rangeText(item.score_range))} / ${escape(numberText(item.weight))} 分` : item.status === 'ineligible' ? '当前情景不适用合格评分' : '待补证'}</p></div><p>${escape(inputSummary(item))}</p>${item.reason ? `<p>${escape(reasonText(item.reason))}</p>` : ''}${item.conditional_range ? `<p class="muted">固定前提下可能范围：${escape(rangeText(item.conditional_range))}；不是已获得分数。</p>` : ''}${item.id === 'relevant_purchase_entry_bid' ? legacyBidDetails(item) : ''}${QUALIFIERS[item.id] ? `<p class="muted">${escape(QUALIFIERS[item.id])}</p>` : ''}<p class="source">依据：${evidenceLinks(item.evidence, registry, prefix)}</p></div>`;
    }).join('')}</section>`;
  }).join('');
}

function legacyBibliography(registry, prefix) {
  if (!registry.length) return '<p>尚未提供可核验的来源记录。</p>';
  return `<ol class="bibliography">${registry.map((entry, index) => `<li id="${prefix}-e${index}"><strong>${sourceLink(string(entry?.source, '未命名来源'), entry?.url ?? entry?.source)}</strong> · ${escape(entry?.observed_at ?? '日期未知')}<p>${escape(string(entry?.scope))}</p>${entry?.path ? `<p class="source">本地记录：${escape(readable(entry.path))}</p>` : ''}${entry?.limitations ? `<p class="muted">限制：${escape(readable(entry.limitations))}</p>` : ''}<span class="source">引用标识：${escape(entry?.id ?? '未知')}</span></li>`).join('')}</ol>`;
}

function legacyDiscoveryDetails(discovery, registry, prefix) {
  if (!discovery || !array(discovery.leads).length) return '';
  return `<details class="card-details discovery-details"><summary>如何发现这款 · ${escape(array(discovery.leads).length)} 个来源词</summary><div class="details-body"><p><strong>${escape(discovery.label)}</strong>：${escape(discovery.description)}</p><p class="source">款式实物依据：${evidenceLinks(discovery.offer_evidence, registry, prefix)}</p><ul>${array(discovery.leads).map(lead => `<li><strong>${escape(lead?.keyword)}</strong>${typeof lead?.reason === 'string' ? `<p>${escape(lead.reason)}</p>` : ''}<ul>${array(lead?.provenance).map(source => `<li class="source">${escape(source?.source_label ?? source?.source_id)} · ${escape(source?.source_period ?? '期间未返回')}；原始记录：${escape(source?.source_path)}，行索引 ${escape(source?.row_index)}${finite(source?.searches) ? `；搜索量 ${escape(numberText(source.searches))}${typeof source.search_units === 'string' ? `（${escape(source.search_units === 'provider_monthly_search_estimate' ? '来源月估算' : source.search_units)}）` : ''}` : '；搜索量未返回'}。</li>`).join('')}</ul></li>`).join('')}</ul><p class="muted">不同来源的搜索量不相加；这些是发现线索，具体得分仍看下方21项证据。</p></div></details>`;
}

function legacyDiscoverySummary(summary) {
  if (!summary || !finite(summary.unique_keywords)) return '';
  const seasonal = summary.dispositions?.seasonal_deferred ?? 0;
  return `<p class="batch-counts">来源词 ${escape(numberText(summary.unique_keywords))} 个；已核对 ${escape(numberText(summary.reviewed_keywords))} 个，待核 ${escape(numberText(summary.pending_keywords - seasonal))} 个，暂缓 ${escape(numberText(seasonal))} 个，搁置专属或无关搜索 ${escape(numberText(summary.excluded_keywords))} 个；已绑定实物候选 ${escape(numberText(summary.bound_candidates))} 个。词数不等于产品数，绑定不代表评分通过。</p>`;
}

function legacyPeriodPanel(period, presentation, registry, prefix) {
  const complete = period.queue === 'comparable' && Array.isArray(period.total_range);
  const gaps = array(period.items).filter(item => item.status === 'needs_evidence');
  const ineligible = array(period.items).filter(item => item.status === 'ineligible');
  const conditions = array(period.screening?.conditions).filter(condition => condition.status !== 'pass');
  const economics = object(period.diagnostics?.economics);
  const contributions = array(economics.scenarios).map(scenario => scenario?.contribution?.value);
  const contribution = contributions.length && contributions.every(finite) ? [Math.min(...contributions), Math.max(...contributions)] : null;
  const margin = array(economics.margin_range).length === 2 ? economics.margin_range.map(value => value * 100) : null;
  const label = { excluded: '本时段排除', deferred: '本时段暂缓' }[period.queue] ?? QUEUES[period.queue] ?? '待补证';
  const incomplete = period.queue === 'excluded' ? '本经营时段不满足筛选条件，不列完整总分' :
    period.queue === 'deferred' ? '本经营时段暂缓，不列完整总分' : '本经营时段完整总分待补证';
  return `<section class="operating-period" data-operating-period="${escape(period.id)}" data-queue="${escape(period.queue)}"><div class="card-title"><h3>${escape(period.label)}</h3><span class="status ${escape(period.queue)}">${label}</span></div><p class="muted">适用月份：${escape(array(period.months).join('、'))}月；本时段独立适用30%毛利条件。</p>${typeof presentation.summary === 'string' ? `<p>${escape(presentation.summary)}</p>` : ''}<div class="score-summary"><p><strong>退款调整后广告前毛利率 ${margin ? `${escape(rangeText(margin))}%` : '未知'}</strong>；单件贡献 ${contribution ? `US$ ${escape(rangeText(contribution))}` : '未知'}。</p>${complete ? `<p class="total">本经营时段完整总分 <strong>${escape(rangeText(period.total_range))} / 100</strong></p>` : `<p class="total incomplete">${incomplete}</p>`}<p>已支持分数 ${escape(rangeText(period.supported_range))}；已计分权重 ${escape(numberText(period.covered_weight))} / 100；不满足合格评分条件 ${ineligible.length} 项；待补证 ${gaps.length} 项。</p>${period.conditional_total_range ? `<p class="muted">满足本时段准入后可能范围 ${escape(rangeText(period.conditional_total_range))}；这是数学界限，不是已获得总分或预测。</p>` : ''}</div>${legacyPresentationRows('本时段核算依据', presentation.facts)}${conditions.length ? `<p class="screen-note">本时段筛选：${conditions.map(condition => `${escape(STATES[condition.status] ?? condition.status)}：${escape(reasonText(condition.reason))}`).join('；')}</p>` : ''}<details class="card-details period-details"><summary>查看${escape(period.label)}的21项评分、费用与证据 · 8组</summary><div class="details-body">${legacyEconomicDetails(period)}${period.profile_revision >= 54 ? '' : legacyPresentationRows('本时段费用明细', presentation.costs)}${legacyScoreRows(period, registry, prefix)}${legacyNewcomerDetails(period)}</div></details></section>`;
}

function legacySeasonalCard(result, original, index) {
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const image = imageUri(presentation.image_data_uri);
  const displays = array(presentation.operating_periods);
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  return `<article class="candidate" id="${prefix}" data-queue="seasonal_review"><div class="card-top">${image ? `<figure class="product-image"><img src="${escape(image)}" alt="${escape(string(presentation.image_alt, string(result.form, '候选产品参考图')))}" width="320" height="320" loading="lazy" decoding="async"><figcaption>${escape(string(presentation.image_caption, '所附参考图，供核对具体规格'))}</figcaption></figure>` : ''}<div class="card-intro"><div class="card-title"><h2>${escape(result.label ?? result.candidate_id)}</h2><span class="status seasonal_review">分季评估</span></div><p class="form">${escape(result.form ?? '具体可售规格尚待明确')}</p>${typeof presentation.summary === 'string' ? `<p>${escape(presentation.summary)}</p>` : ''}<p class="screen-note">同一款式的经营时段分别评估，由主人选择经营季节。各时段的费用、毛利与21项得分分别阅读，不合并全年总分或按最佳时段排序。</p></div></div>${legacyPresentationRows('款式事实与共同依据', presentation.facts)}${legacyDiscoveryDetails(original?.discovery, registry, prefix)}${blockers.length ? `<section class="next-evidence"><h3>共同问题与后续处理</h3><ul>${blockers.map(row => `<li><strong>${escape(row.problem)}</strong>${typeof row.next_step === 'string' ? `<p>下一步：${escape(row.next_step)}</p>` : ''}</li>`).join('')}</ul></section>` : ''}${array(result.operating_periods).map(period => legacyPeriodPanel(period, object(displays.find(display => display?.id === period.id)), registry, prefix)).join('')}<details class="card-details"><summary>查看共同采购资料与来源限制</summary><div class="details-body">${result.profile_revision >= 54 ? '' : legacyPresentationRows('共同费用资料', presentation.economics_details)}${legacyPresentationRows('采购参考与规格核对', presentation.procurement)}${legacyPresentationRows('市场范围与新增观察', presentation.market_references)}<section class="support-section"><h3>来源与适用限制</h3>${legacyBibliography(registry, prefix)}</section></div></details></article>`;
}

function legacyCandidateCard(result, original, index) {
  if (result.queue === 'seasonal_review') return legacySeasonalCard(result, original, index);
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const image = imageUri(presentation.image_data_uri);
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  const gaps = array(result.items).filter(item => item.status === 'needs_evidence');
  const mainGaps = blockers.length ? blockers : gaps.slice(0, 3).map(item => ({ problem: `${ITEM_LABELS[item.id] ?? item.id}：${reasonText(item.reason)}`, next_step: '补齐对应来源和适用口径后重新计算。' }));
  const screenGaps = array(result.screening?.conditions).filter(condition => condition.status !== 'pass');
  const queue = Object.hasOwn(QUEUES, result.queue) ? result.queue : 'pending';
  const complete = queue === 'comparable' && Array.isArray(result.total_range);
  const incompleteLabel = queue === 'excluded' ? '当前规格已排除，不列完整总分' : queue === 'deferred' ? '本期暂缓，不列完整总分' : '完整总分待补证';
  const ineligible = array(result.items).filter(item => item.status === 'ineligible');
  const coverageText = ineligible.length
    ? `已计分权重 ${numberText(result.covered_weight)} / 100；不满足合格评分条件 ${ineligible.length} 项；待补证 ${gaps.length} 项。`
    : `证据覆盖权重 ${numberText(result.covered_weight)} / 100；未评分权重 ${numberText(result.unscored_weight)}。`;
  return `<article class="candidate" id="${prefix}" data-queue="${queue}"><div class="card-top">${image ? `<figure class="product-image"><img src="${escape(image)}" alt="${escape(string(presentation.image_alt, string(result.form, '候选产品参考图')))}" width="320" height="320" loading="lazy" decoding="async"><figcaption>${escape(string(presentation.image_caption, '所附参考图，供核对具体规格'))}</figcaption></figure>` : ''}<div class="card-intro"><div class="card-title"><h2>${escape(result.label ?? result.candidate_id)}</h2><span class="status ${queue}">${QUEUES[queue]}</span></div><p class="form">${escape(result.form ?? '具体可售规格尚待明确')}</p>${typeof presentation.summary === 'string' ? `<p>${escape(presentation.summary)}</p>` : ''}<div class="score-summary">${complete ? `<p class="total">完整总分 <strong>${escape(rangeText(result.total_range))} / 100</strong></p>` : `<p class="total incomplete">${escape(incompleteLabel)}</p>`}<p><strong>已支持分数 ${escape(rangeText(result.supported_range))}</strong>；${escape(coverageText)}</p>${result.conditional_total_range ? `<p class="muted">满足准入后可能范围 ${escape(rangeText(result.conditional_total_range))}。这是数学界限，不是已获得总分或预测。</p>` : ''}${result.may_exceed_comparable_leader ? '<p class="priority-note">有效可能上界高于当前完整队列首项的保守端点，值得补证；这不代表已经胜出。</p>' : ''}</div></div></div>
    ${legacyDiscoveryDetails(original?.discovery, registry, prefix)}
    ${mainGaps.length ? `<section class="next-evidence"><h3>${queue === 'excluded' && gaps.length === 0 ? '排除原因与后续处理' : '需要解决的缺口'}</h3><ul>${mainGaps.map(row => `<li><strong>${escape(row.problem)}</strong>${typeof row.next_step === 'string' ? `<p>下一步：${escape(row.next_step)}</p>` : ''}</li>`).join('')}</ul></section>` : ''}
    ${screenGaps.length ? `<p class="screen-note">筛选状态：${screenGaps.map(condition => `${escape({ reference_price: '参考售价', margin: '毛利条件', specific_form_rights: '具体款式权利', strong_date_dependency: '日期依赖' }[condition.id] ?? condition.id)}${escape(STATES[condition.status] ?? condition.status)}：${escape(reasonText(condition.reason))}`).join('；')}</p>` : '<p class="screen-note">初筛条件已得到有据判断；这不是采购批准或供应验证。</p>'}
    <details class="card-details"><summary>查看21项评分与证据 · 8组</summary><div class="details-body">${legacyScoreRows(result, registry, prefix)}${legacyEconomicDetails(result)}${result.profile_revision >= 54 ? '' : legacyPresentationRows('费用明细补充', presentation.economics_details)}${legacyPresentationRows('采购参考与规格核对', presentation.procurement)}${legacyNewcomerDetails(result)}${legacyPresentationRows('市场范围与新增观察', presentation.market_references)}<section class="support-section"><h3>来源与适用限制</h3>${legacyBibliography(registry, prefix)}</section></div></details></article>`;
}

function legacyBatchContext(presentation) {
  const linkedSummary = legacyDiscoverySummary(presentation.discovery_summary);
  const discovery = array(presentation.discovery);
  const timings = array(presentation.timings);
  const limitations = array(presentation.limitations);
  if (!discovery.length && !timings.length && !limitations.length) return linkedSummary;
  return `${linkedSummary}<details class="batch-context"><summary>查看发现路径、耗时与本轮限制</summary><div class="details-body">${discovery.length ? `<h2>发现与覆盖记录</h2><ul>${discovery.map(value => {
    if (typeof value === 'string') return `<li>${escape(value)}</li>`;
    const row = object(value);
    return `<li><strong>${escape(string(row.label, '发现记录'))}</strong>${typeof row.detail === 'string' ? `：${escape(row.detail)}` : ''}${typeof row.status === 'string' ? `（${escape(row.status)}）` : ''}${row.source || safeHttpUrl(row.url) ? `<p class="source">${sourceLink(string(row.source, '查看来源'), row.url)}${typeof row.observed_at === 'string' ? ` · ${escape(row.observed_at)}` : ''}</p>` : ''}</li>`;
  }).join('')}</ul>` : ''}${timings.length ? `<h2>记录耗时</h2><dl class="reference-rows">${timings.map(value => {
    const row = object(value);
    return `<div><dt>${escape(string(row.label, '阶段'))}</dt><dd>${finite(row.seconds) && row.seconds >= 0 ? `${escape(numberText(row.seconds))} 秒` : '未测量'}${typeof row.note === 'string' ? `<p class="muted">${escape(row.note)}</p>` : ''}</dd></div>`;
  }).join('')}</dl>` : ''}${limitations.length ? `<h2>本轮限制</h2><ul>${limitations.map(value => `<li>${escape(readable(value))}</li>`).join('')}</ul>` : ''}</div></details>`;
}

const LEGACY_CSS = `
:root{color-scheme:light;--ink:#243238;--muted:#52626a;--paper:#fff;--ground:#f3f4ef;--line:#d5ddd6;--accent:#205f55;--accent-soft:#ecf5ef;--pending:#75501f;--pending-soft:#fff4df;--danger:#8c3040;--danger-soft:#fff0f2;--radius:14px;--space:24px}
*{box-sizing:border-box}html{scroll-behavior:auto;scroll-padding-top:24px}body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.7 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;overflow-wrap:anywhere}::selection{background:#c5e5d8;color:#163c34}a{color:var(--accent);text-underline-offset:.2em;text-decoration-thickness:1px}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible{outline:3px solid #246b92;outline-offset:4px;border-radius:4px}main{width:min(1120px,100%);margin:0 auto;padding:40px 24px 64px}h1,h2,h3,h4,p,figure,dl{margin:0}h1{font-size:clamp(1.65rem,3vw,2.3rem);line-height:1.3;letter-spacing:-.025em;font-weight:700}h2{font-size:1.28rem;line-height:1.45}h3{font-size:1.05rem;line-height:1.5}h4{font-size:1rem;line-height:1.5}p+p{margin-top:8px}ul,ol{padding-inline-start:1.35em;margin:10px 0}li+li{margin-top:10px}header>p{max-width:74ch;margin-top:16px}.batch-counts{color:var(--muted)}.queue-nav{display:flex;gap:10px 22px;flex-wrap:wrap;margin:20px 0 0}.queue-nav a{padding:5px 0}.batch-context{border-block:1px solid var(--line);margin:24px 0 32px}summary{cursor:pointer;min-height:48px;padding:13px 0;font-weight:600;color:var(--accent)}summary::marker{font-size:.8em}summary:hover{color:#123f37}.candidate{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);margin-top:24px;padding:28px;min-width:0;scroll-margin-top:24px}.card-top{display:flex;gap:24px;align-items:flex-start}.card-intro{flex:1;min-width:0}.card-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 14px}.card-title h2{flex:1;min-width:min(230px,100%)}.status{font-size:.82rem;font-weight:650;border-radius:6px;padding:3px 9px;white-space:nowrap}.status.comparable{color:var(--accent);background:var(--accent-soft)}.status.pending,.status.deferred{color:var(--pending);background:var(--pending-soft)}.status.excluded{color:var(--danger);background:var(--danger-soft)}.form{font-weight:600;margin:10px 0 8px}.product-image{flex:0 0 158px;max-width:100%}.product-image img{display:block;width:158px;height:158px;max-width:100%;object-fit:contain;background:#fafbf7;border-radius:8px}.product-image figcaption{font-size:.76rem;line-height:1.5;color:var(--muted);margin-top:8px}.score-summary{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}.total{font-size:1.05rem}.total strong{font-size:1.28rem;margin-inline-start:8px}.total.incomplete{font-weight:650;color:var(--pending)}.muted,.source{color:var(--muted)}.source{font-size:.86rem;line-height:1.65}.priority-note{color:var(--accent)}.next-evidence{margin-top:24px}.next-evidence li p{color:var(--muted);font-size:.94rem;margin-top:3px}.screen-note{font-size:.9rem;color:var(--muted);margin-top:20px}.card-details{border-top:1px solid var(--line);margin-top:20px}.details-body{padding:8px 0 20px;min-width:0}.score-group{margin-top:24px}.score-group:first-child{margin-top:8px}.score-group>h3{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 20px;padding-bottom:10px;border-bottom:1px solid var(--line)}.score-group>h3 span{font-size:.83rem;color:var(--muted);font-weight:400}.item-row{padding:18px 0;border-bottom:1px solid #e9eee9;font-size:.94rem}.item-heading{display:flex;justify-content:space-between;gap:10px 20px;align-items:baseline;margin-bottom:7px}.item-score{font-size:.9rem;font-weight:600;flex-shrink:0;font-variant-numeric:tabular-nums}.item-row>.source{margin-top:10px}.item-support{margin:14px 0 8px}.bid-entry{padding:12px 0}.bid-entry+.bid-entry{border-top:1px dotted var(--line)}.support-section{margin-top:32px}.support-section>h3{margin-bottom:10px}.reference-rows>div{display:grid;grid-template-columns:minmax(110px,1fr) minmax(0,4fr);gap:16px;padding:13px 0;border-bottom:1px solid #e9eee9}.reference-rows dt{font-weight:600}.reference-rows dd{margin:0;min-width:0}.bibliography li{padding:8px 0;scroll-margin-top:24px}.batch-context h2{font-size:1.05rem;margin:20px 0 10px}.empty-state{padding:32px 0}.report-footer{font-size:.88rem;color:var(--muted);margin-top:32px;padding-top:20px;border-top:1px solid var(--line);max-width:74ch}.skip-link{position:absolute;top:-100px;left:12px;background:white;padding:10px;z-index:2}.skip-link:focus{top:8px}
.operating-period{margin-top:28px;padding-top:24px;border-top:1px solid var(--line)}.status.seasonal_review{color:var(--accent);background:var(--accent-soft)}
@media(max-width:620px){main{padding:24px 14px 40px}.candidate{padding:20px 16px}.card-top{flex-direction:column;gap:16px}.product-image{flex-basis:auto;display:flex;align-items:center;gap:14px;width:100%}.product-image img{width:112px;height:112px;flex-shrink:0}.product-image figcaption{max-width:28ch}.card-title h2{min-width:0;flex-basis:100%}.item-heading{display:block}.item-score{margin-top:5px}.reference-rows>div{grid-template-columns:1fr;gap:5px}.score-group>h3{display:block}.score-group>h3 span{display:block;margin-top:4px}.total strong{display:inline-block;margin-inline-start:4px}.queue-nav{gap:6px 18px}.card-details summary{padding-block:14px}.source{font-size:.84rem}}
@media print{body{background:#fff;color:#111;font-size:10pt}main{width:100%;padding:0}.queue-nav,.skip-link{display:none}.candidate{border-radius:0;padding:16pt 0;border-inline:0;break-inside:auto}.card-details,.batch-context{display:block}details::details-content{display:block;content-visibility:visible}details>*{display:block!important}summary{color:#111;padding:10pt 0}.item-row,.reference-rows>div,.bibliography li{break-inside:avoid}.product-image img{width:90pt;height:90pt}.product-image{flex-basis:100pt}.source,.muted{color:#333}a{color:#111}.report-footer{margin-top:16pt}}
`;

function renderLegacyReport(result, batch = {}) {
  const presentation = { ...object(batch?.presentation), discovery_summary: batch?.discovery_summary };
  const candidates = array(result?.candidates);
  const originals = new Map(array(batch?.candidates).map(candidate => [candidate?.id, candidate]));
  const title = string(presentation.title, '选品试评记录');
  const counts = object(result?.summary);
  const seasonalCounts = counts.seasonal_review ? `分季评估 ${escape(numberText(counts.seasonal_review))} 个款式，其中至少一季初评通过 ${escape(numberText(counts.seasonal_eligible))} 个款式，仅计入至少有一个时段达到完整可比的款式；经营季节由主人选择。` : '';
  const queueLinks = Object.entries(QUEUES).map(([key, label]) => {
    const index = candidates.findIndex(candidate => candidate?.queue === key);
    return index >= 0 ? `<a href="#candidate-${index + 1}">${label} ${escape(numberText(counts[key === 'comparable' ? 'complete' : key]))}</a>` : '';
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>${LEGACY_CSS}</style></head><body><a class="skip-link" href="#cards">跳到候选卡</a><main><header><h1>${escape(title)}</h1>${typeof presentation.summary === 'string' ? `<p>${escape(presentation.summary)}</p>` : ''}<p class="batch-counts">本轮 ${escape(numberText(candidates.length))} 个候选；完整可比 ${escape(numberText(counts.complete))} 个，待补证 ${escape(numberText(counts.pending))} 个。${seasonalCounts}完整得分、证据覆盖和补证优先级分别阅读。</p>${queueLinks ? `<nav class="queue-nav" aria-label="跳转候选队列">${queueLinks}</nav>` : ''}</header>${legacyBatchContext(presentation)}<section id="cards" aria-label="候选产品卡">${candidates.length ? candidates.map((candidate, index) => legacyCandidateCard(object(candidate), originals.get(candidate?.candidate_id), index)).join('') : '<div class="empty-state"><h2>本轮没有候选卡</h2><p>保留发现与覆盖记录；没有候选不等于市场中没有机会。</p></div>'}</section><footer class="report-footer"><p>评分反映本轮证据与已确认试评规则。未知不按零计，不把已知部分折算为100分；初步评分、供应验证、主人决定与实际经营效果分别核验。</p><p>规则版本：修订 ${escape(result?.profile_revision ?? '未知')}。本页可离线展开和打印；查看与重新计算不会提交市场或模型请求。</p></footer></main></body></html>`;
}

// ============================================================================
// Achromatic Split-Inspector Workbench (revision 57+)
// ============================================================================
function minMaxRange(values) {
  const nums = values.filter(finite);
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
}

function usdRangeText(range) {
  return range ? `US$ ${escape(rangeText(range))}` : '待补证';
}

function pctRangeText(range) {
  if (!range) return '待补证';
  const [lo, hi] = range.map(v => v * 100);
  if (Math.abs(hi - lo) <= 1e-9) return `${escape(numberText(lo))}%`;
  if (lo < 0 || hi < 0) return `${escape(numberText(lo))}% 至 ${escape(numberText(hi))}%`;
  return `${escape(rangeText([lo, hi]))}%`;
}

function resolvePrimarySeasonalPeriodR58(candidate, rev = candidate?.profile_revision ?? 58) {
  if (candidate?.queue !== 'seasonal_review' || !Array.isArray(candidate.operating_periods)) return null;
  const monthsReq8 = [2, 3, 4, 5, 6, 7, 8, 9];
  const monthsReq9 = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const targetId = candidate?.qualification?.primary_period_id ?? candidate?.qualification?.display_period_id ?? null;
  return (targetId && candidate.operating_periods.find(p => p?.id === targetId))
    ?? candidate.operating_periods.find(p => Array.isArray(p?.months) && (
      (p.months.length === monthsReq8.length && monthsReq8.every(m => p.months.includes(m))) ||
      (rev >= 59 && p.months.length === monthsReq9.length && monthsReq9.every(m => p.months.includes(m)))
    ))
    ?? candidate.operating_periods[0]
    ?? null;
}

function isPrivateMoldReservedR59(candidate, rev = candidate?.profile_revision ?? 0) {
  return rev >= 59 && (
    candidate?.effective_disposition === 'private_mold_reserved' ||
    candidate?.qualification?.mode === 'private_mold_reserved'
  );
}

function candidateFilterBucket(candidate, rev = candidate?.profile_revision ?? 0) {
  if (isPrivateMoldReservedR59(candidate, rev)) return 'reserved';
  if (isCandidateEligible(candidate, rev)) return 'eligible';
  if (candidate?.queue === 'excluded' || candidate?.queue === 'deferred') return 'hold';
  if (rev >= 58 && candidate?.queue === 'seasonal_review') {
    const prim = resolvePrimarySeasonalPeriodR58(candidate, rev);
    if (prim?.queue === 'excluded' || prim?.queue === 'deferred') return 'hold';
  }
  return 'pending';
}

function isCandidateEligible(candidate, rev = candidate?.profile_revision ?? 0) {
  if (rev >= 58) return candidate?.qualification?.counts_toward_target === true;
  if (candidate?.queue === 'comparable') return true;
  if (candidate?.queue === 'seasonal_review') {
    const monthsReq = [2, 3, 4, 5, 6, 7, 8, 9];
    const hasPeak = array(candidate.operating_periods).some(p => [10, 11, 12].every(m => array(p?.months).includes(m)));
    return hasPeak && array(candidate.operating_periods).some(p =>
      p?.queue === 'comparable' && monthsReq.every(m => array(p?.months).includes(m)));
  }
  return false;
}

function sInputs(scenarios, calc) {
  const match = scenarios.find(s => s?.input?.calculation === calc);
  return match?.input?.cost_ledger?.source_inputs ?? null;
}

function calcMeetsFloor30(calc, sc = null) {
  if (sc?.coherence_supported === true && typeof sc.margin_eligible === 'boolean') return sc.margin_eligible;
  if (calc && finite(calc.price_usd) && finite(calc.refund_fraction) && Array.isArray(calc.lines) && calc.margin !== null && calc.margin !== undefined) {
    try { return ledgerMeetsMarginFloor(calc, 0.3); } catch {}
  }
  if (sc && typeof sc.margin_eligible === 'boolean') return sc.margin_eligible;
  if (finite(calc?.margin)) return calc.margin >= 0.3;
  if (finite(sc?.input?.margin?.value)) return sc.input.margin.value >= 0.3;
  return null;
}

function extractMetricsSnapshot(candidate, rev = candidate?.profile_revision ?? 0) {
  const target = candidate?.queue === 'seasonal_review'
    ? (rev >= 58
      ? ((candidate?.qualification?.display_period_id
        ? array(candidate.operating_periods).find(p => p?.id === candidate.qualification.display_period_id)
        : null) ?? array(candidate.operating_periods)[0] ?? candidate)
      : (array(candidate.operating_periods).find(p => p?.queue === 'comparable') ?? array(candidate.operating_periods)[0] ?? candidate))
    : candidate;
  const scenarios = array(target?.diagnostics?.economics?.scenarios);
  const scoredLedgers = scenarios
    .filter(s => rev < 58 || isScoredSupportedR58(s))
    .map(s => s?.input?.calculation)
    .filter(c => c && c.status !== 'sensitivity_only');
  const sensitivityScenarios = rev >= 58
    ? []
    : scenarios.filter(s => s?.input?.calculation?.status === 'sensitivity_only');
  const primarySensScenarios = sensitivityScenarios.filter(s => s?.input?.cost_ledger?.source_inputs?.matched_grade_primary === true);
  const chosenSensLedgers = (primarySensScenarios.length ? primarySensScenarios : sensitivityScenarios).map(s => s.input.calculation);
  const activeLedgers = scoredLedgers.some(c => finite(c?.margin)) ? scoredLedgers : (chosenSensLedgers.length ? chosenSensLedgers : scoredLedgers);
  const isSensitivity = !scoredLedgers.some(c => finite(c?.margin)) && chosenSensLedgers.some(c => finite(c?.margin));

  const validatedRefPrice = rev >= 58
    ? (() => {
      const rp = array(target?.screening?.conditions).find(c => c?.id === 'reference_price' && c?.status === 'pass');
      return finite(rp?.input?.value) ? [rp.input.value, rp.input.value] : null;
    })()
    : null;
  const bareGoodsBounds = rev >= 58 && Array.isArray(target?.diagnostics?.economics?.bare_goods_margin_upper_bounds) &&
    target.diagnostics.economics.bare_goods_margin_upper_bounds.length === 2
    ? target.diagnostics.economics.bare_goods_margin_upper_bounds
    : null;
  const nonSensCoherentCalcs = rev >= 58
    ? scenarios
      .filter(s => s?.input?.coherent === true && !(s?.input?.cost_ledger?.sensitivity_only === true))
      .map(s => s?.input?.calculation)
      .filter(Boolean)
    : [];
  const prices = minMaxRange(activeLedgers.map(c => c?.price_usd)) ??
    (bareGoodsBounds ? minMaxRange(nonSensCoherentCalcs.map(c => c?.price_usd)) : null) ??
    validatedRefPrice;
  const domesticDelivered = minMaxRange(activeLedgers.map(c => {
    const proc = array(c?.lines).find(l => l.id === 'procurement')?.amount_usd;
    const dom = array(c?.lines).find(l => l.id === 'domestic_freight')?.amount_usd;
    return finite(proc) && finite(dom) ? proc + dom : null;
  }));
  const margins = Array.isArray(target?.diagnostics?.economics?.margin_range) && target.diagnostics.economics.margin_range.length === 2
    ? target.diagnostics.economics.margin_range
    : (minMaxRange(activeLedgers.map(c => c?.margin)) ?? bareGoodsBounds);
  let marginFloorStatus = 'unknown';
  const hasUnresolvedPrimaryScenario = rev >= 59 && (
    Boolean(target?.diagnostics?.economics?.expected_structural_error) ||
    scenarios.some(s => !(s?.input?.cost_ledger?.sensitivity_only === true) && !isScoredSupportedR58(s))
  );
  const marginScreenStatus = array(target?.screening?.conditions).find(c => c?.id === 'margin')?.status ?? null;
  if (rev >= 58) {
    if (hasUnresolvedPrimaryScenario) {
      marginFloorStatus = marginScreenStatus === 'fail' ? 'fail' : 'unknown';
    } else {
      const ledgerVerdicts = activeLedgers
        .map(c => calcMeetsFloor30(c, scenarios.find(s => s?.input?.calculation === c)))
        .filter(v => typeof v === 'boolean');
      if (ledgerVerdicts.length) {
        marginFloorStatus = ledgerVerdicts.every(Boolean) ? 'pass' : ledgerVerdicts.every(v => !v) ? 'fail' : 'cross';
      } else if (margins) {
        marginFloorStatus = margins[0] >= 0.3 ? 'pass' : margins[1] < 0.3 ? 'fail' : 'cross';
      }
    }
  } else if (margins) {
    marginFloorStatus = margins[0] >= 0.3 ? 'pass' : margins[1] < 0.3 ? 'fail' : 'cross';
  }
  const adMargins = minMaxRange(activeLedgers.map(c => c?.advertising_scenario_margin));
  const eligibleScenarios = rev >= 58 ? scenarios.filter(isScoredSupportedR58) : scenarios;
  const contributions = minMaxRange(
    eligibleScenarios.map(s => s?.contribution?.value).filter(finite).length
      ? eligibleScenarios.map(s => s?.contribution?.value)
      : activeLedgers.map(c => c?.contribution_usd),
  );
  const cnyTotals = minMaxRange(activeLedgers.map(c => {
    const si = sInputs(scenarios, c);
    return finite(si?.procurement_cny) && finite(si?.domestic_per_unit_cny) ? si.procurement_cny + si.domestic_per_unit_cny : null;
  }));
  const orderUnitsRange = rev >= 58
    ? minMaxRange(activeLedgers.map(c => {
      const si = sInputs(scenarios, c);
      const procLine = array(c?.lines).find(l => l.id === 'procurement');
      const domLine = array(c?.lines).find(l => l.id === 'domestic_freight');
      const u = procLine?.order_units ?? domLine?.order_units ?? si?.order_units ?? si?.complete_saleable_sets ?? null;
      return finite(u) && u > 0 ? u : null;
    }))
    : null;
  const capCandidateScenarios = rev >= 58
    ? (activeLedgers.length
      ? scenarios.filter(s => activeLedgers.includes(s?.input?.calculation))
      : scenarios.filter(s => {
        const cl = s?.input?.cost_ledger;
        const c = s?.input?.calculation;
        if (!c || cl?.sensitivity_only === true || cl?.sensitivity_only === 'true') return false;
        if (s?.input?.coherent === false) return false;
        if (validatedRefPrice && finite(c.price_usd) && c.price_usd > validatedRefPrice[1] + 1e-6) return false;
        return true;
      }))
    : [];
  const landedCapUsd = rev >= 58
    ? minMaxRange(capCandidateScenarios.map(s => s?.input?.calculation?.landed_domestic_cap_at_30pct_usd))
    : null;
  const landedCapCny = rev >= 58
    ? minMaxRange(capCandidateScenarios.map(s => {
      const c = s?.input?.calculation;
      if (finite(c?.landed_domestic_cap_at_30pct_cny)) return c.landed_domestic_cap_at_30pct_cny;
      const si = s?.input?.cost_ledger?.source_inputs;
      const fx = finite(si?.fx_cny_per_usd) ? si.fx_cny_per_usd : si?.fx_usdcny;
      return finite(c?.landed_domestic_cap_at_30pct_usd) && finite(fx) && fx > 0
        ? c.landed_domestic_cap_at_30pct_usd * fx
        : null;
    }))
    : null;
  const targetGoodsCnyAt30Pct = rev >= 59
    ? minMaxRange(capCandidateScenarios.map(s => {
      const c = s?.input?.calculation;
      const cl = s?.input?.cost_ledger;
      const si = cl?.source_inputs;
      const procLineRaw = array(cl?.lines).find(l => l?.id === 'procurement');
      const domLineRaw = array(cl?.lines).find(l => l?.id === 'domestic_freight');
      const fx = [si?.fx_cny_per_usd, si?.fx_usdcny, cl?.fx_cny_per_usd, procLineRaw?.fx_cny_per_usd, domLineRaw?.fx_cny_per_usd]
        .find(v => finite(v) && v > 0) ?? null;
      const capCny = finite(c?.landed_domestic_cap_at_30pct_cny)
        ? c.landed_domestic_cap_at_30pct_cny
        : (finite(c?.landed_domestic_cap_at_30pct_usd) && fx !== null
          ? c.landed_domestic_cap_at_30pct_usd * fx
          : null);
      if (capCny === null) return null;
      const domUsd = array(c?.lines).find(l => l?.id === 'domestic_freight')?.amount_usd ?? domLineRaw?.amount_usd ?? null;
      const domCny = finite(domUsd) && fx !== null ? domUsd * fx : 0;
      return Math.max(0, capCny - domCny);
    }))
    : null;
  const stressMargins = rev >= 58
    ? minMaxRange(array(target?.diagnostics?.economics?.stress_scenarios).map(st => st?.margin))
    : null;
  const complete = Array.isArray(target?.total_range) && (
    target?.queue === 'comparable' ||
    (rev >= 59 && target?.diagnostics?.economics?.crossing_margin_floor === true)
  );
  let crossingPassSummary = null;
  let crossingBelowSummary = null;
  if (rev >= 59 && target?.diagnostics?.economics?.crossing_margin_floor === true) {
    const fmtCrossingScen = s => {
      const qid = s?.input?.quote_id ?? s?.input?.cost_ledger?.source_inputs?.quote_id ?? null;
      const tag = typeof qid === 'string' && qid.trim() ? qid.trim() : string(s?.id, '情景');
      const mPct = finite(s?.margin?.value) ? `（${numberText(s.margin.value * 100)}%）` : '';
      return `${tag}${mPct}`;
    };
    const passScens = scenarios.filter(s => s?.coherence_supported && s?.margin_eligible === true);
    const failScens = scenarios.filter(s => s?.coherence_supported && s?.margin_eligible === false);
    if (passScens.length > 0 && failScens.length > 0) {
      crossingPassSummary = passScens.map(fmtCrossingScen).join('、');
      crossingBelowSummary = failScens.map(fmtCrossingScen).join('、');
    }
  }
  const sampleCheckItems = rev >= 59
    ? array(target?.sample_check_items ?? candidate?.sample_check_items ?? candidate?.qualification?.sample_check_items)
    : [];
  return {
    target,
    prices,
    domesticDelivered,
    cnyTotals,
    orderUnitsRange,
    landedCapUsd,
    landedCapCny,
    targetGoodsCnyAt30Pct,
    margins,
    stressMargins,
    marginFloorStatus,
    crossingPassSummary,
    crossingBelowSummary,
    adMargins,
    contributions,
    isSensitivity,
    complete,
    totalRange: complete ? target.total_range : null,
    supportedRange: target?.supported_range ?? candidate?.supported_range ?? null,
    coveredWeight: target?.covered_weight ?? candidate?.covered_weight ?? 0,
    sampleCheckItems,
    periodLabel: candidate?.queue === 'seasonal_review' ? string(target?.label, '主营时段') : '全时段',
  };
}

function statusDotInfo(candidate, snapshot, rev = candidate?.profile_revision ?? 0) {
  if (isPrivateMoldReservedR59(candidate, rev)) {
    return { tone: 'pending', text: '疑似私模／需开模留档' };
  }
  const eligible = isCandidateEligible(candidate, rev);
  if (eligible) {
    if (rev >= 59 && snapshot?.sampleCheckItems?.length > 0) {
      return {
        tone: 'pass',
        text: candidate.queue === 'seasonal_review' ? '淡季入围 · 含拿样待核项' : '入围可推进 · 含拿样待核项',
      };
    }
    return {
      tone: 'pass',
      text: candidate.queue === 'seasonal_review' ? '淡季达标 · 可推进' : '完整达标 · 可推进',
    };
  }
  if (rev >= 59 && (candidate?.effective_disposition === 'crossing_30pct_interval' || snapshot?.target?.diagnostics?.economics?.crossing_margin_floor === true)) {
    return {
      tone: 'pending',
      text: snapshot?.complete ? '跨 30% 红线 · 区间可比' : '跨 30% 红线 · 待核',
    };
  }
  if (candidate.queue === 'excluded') return { tone: 'fail', text: '不满足条件 · 排除' };
  if (candidate.queue === 'deferred') return { tone: 'pending', text: '强节日款 · 暂缓' };
  if (rev >= 58 && candidate.queue === 'seasonal_review') {
    const prim = resolvePrimarySeasonalPeriodR58(candidate);
    if (prim?.queue === 'excluded') return { tone: 'fail', text: '主营淡季不满足 · 排除' };
    if (prim?.queue === 'deferred') return { tone: 'pending', text: '主营淡季暂缓' };
  }
  if (snapshot.isSensitivity && snapshot.margins && (rev >= 58 ? snapshot.marginFloorStatus === 'fail' : snapshot.margins[1] < 0.3)) {
    return { tone: 'fail', text: '同精度毛利不足 · 搁置' };
  }
  return { tone: 'pending', text: '待补齐证据' };
}

function renderDotStatus(candidate, snapshot, rev = candidate?.profile_revision ?? 0) {
  const info = statusDotInfo(candidate, snapshot, rev);
  return `<span class="state-inline state-${info.tone}"><i class="dot" aria-hidden="true"></i>${escape(info.text)}</span>`;
}

function starReferenceSection(original) {
  const raw = original?.presentation?.niche_average_star_reference ?? original?.market?.average_star_rating;
  if (raw === null || raw === undefined) return '';
  const rating = finite(raw) ? raw : finite(raw?.value) ? raw.value : null;
  if (rating === null || rating <= 0 || rating > 5) return '';
  const scope = typeof raw === 'object' ? string(raw.scope || raw.population || original?.market?.population) : string(original?.market?.population);
  const period = typeof raw === 'object' ? string(raw.period || original?.market?.period) : string(original?.market?.period);
  const note = typeof raw === 'object' ? string(raw.note, '仅作细分市场口碑与预期参考，不纳入100分评分。') : '仅作细分市场口碑与预期参考，不纳入100分评分。';
  return `<p class="star-ref">细分市场显示均星参考（不计分）：<strong>${escape(numberText(rating))} 星</strong>${scope ? ` · ${escape(scope)}` : ''}${period ? `（${escape(period)}）` : ''}。${escape(note)}</p>`;
}

function formatCleanBullet(text, rev = 57) {
  const escaped = escape(text);
  const sep = rev >= 58 ? '·' : '—';
  const bracket = escaped.match(/^【([^】]{1,20})】(.*)$/s);
  if (bracket) return `<strong>${bracket[1]}</strong> ${sep} ${bracket[2]}`;
  const colon = escaped.match(/^([^：:；。]{2,18})[：:](.*)$/s);
  if (colon) return `<strong>${colon[1]}：</strong>${colon[2]}`;
  return escaped;
}

function r57BriefList(title, value, rev = 57) {
  const items = array(value).filter(item => (typeof item === 'string' && item.trim()) ||
    (item && typeof item === 'object' && !Array.isArray(item) && (typeof item.label === 'string' || typeof item.problem === 'string' || item.value !== undefined)));
  if (!items.length) return '';
  return `<div class="brief-col"><h3>${escape(title)}</h3><ul class="brief-list">${items.map(item => {
    if (typeof item === 'string') return `<li>${formatCleanBullet(item, rev)}</li>`;
    const head = string(item.label || item.problem, '提示');
    const detail = item.value !== undefined ? `：${escape(readable(item.value))}${typeof item.unit === 'string' ? ` ${escape(item.unit)}` : ''}` : '';
    const note = string(item.note || item.next_step);
    const source = string(item.source);
    return `<li><strong>${escape(head)}</strong>${detail}${note ? `<p class="muted">${escape(note)}</p>` : ''}${source || safeHttpUrl(item.url) ? `<p class="source">来源：${sourceLink(source || '查看来源', item.url)}</p>` : ''}</li>`;
  }).join('')}</ul></div>`;
}

const SVG_UP = '<svg class="ico" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5V2.5M2.75 5.75 6 2.5l3.25 3.25"/></svg>';
const SVG_DOWN = '<svg class="ico" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5v7M2.75 6.25 6 9.5l3.25-3.25"/></svg>';
const SVG_EXT = '<svg class="ico" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4"/></svg>';

function r57KeyValueSection(title, value) {
  const rows = array(value).filter(row => row && typeof row === 'object' && !Array.isArray(row));
  if (!rows.length) return '';
  return `<section class="ledger-section"><h3>${escape(title)}</h3><dl class="kv-rows">${rows.map(row => {
    const label = string(row.label, '补充记录');
    const main = `${readable(row.value)}${typeof row.unit === 'string' ? ` ${row.unit}` : ''}`;
    const note = string(row.note);
    const source = string(row.source);
    const validUrl = safeHttpUrl(row.url);
    return `<div class="kv-row"><dt>${escape(label)}</dt><dd><div class="kv-main">${escape(main)}${validUrl ? ` <a class="pill-link" href="${escape(validUrl)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escape(source || '查看来源')} ${SVG_EXT}</a>` : ''}</div>${note ? `<p class="muted">${escape(note)}</p>` : ''}${!validUrl && source ? `<p class="source">来源：${escape(source)}</p>` : ''}</dd></div>`;
  }).join('')}</dl></section>`;
}

function r57BidDetails(item) {
  if (!array(item.entries).length) return '';
  const single = item.aggregation_method === 'single_main_entry';
  const equal = item.aggregation_method === 'equal_main_entries';
  const unbidDeduct = item.unbid_after_all_tiers === true;
  const scopeHtml = typeof item.scope_badge === 'string' && item.scope_badge
    ? `<p class="muted"><strong>${escape(item.scope_badge)}</strong>${typeof item.proxy_reason === 'string' && item.proxy_reason ? ` · ${escape(sanitizeTextPaths(item.proxy_reason))}` : ''}</p>`
    : '';
  const deductHtml = unbidDeduct && typeof item.deduction_note === 'string'
    ? `<p class="ink-fail">${escape(item.deduction_note)}</p>`
    : '';
  const longTailList = array(item.long_tail_opportunistic_terms);
  const longTailHtml = longTailList.length
    ? `<p class="muted"><strong>蓝海捡漏词（仅作参考 · 不锁死主分）：</strong>${longTailList.map(t => `<code class="mono-kw">${escape(t.query)}</code>${finite(t.volume) ? `（月搜 ${escape(numberText(t.volume))}）` : ''}`).join(' ／ ')}</p>`
    : '';
  return `<div class="bid-block"><p class="bid-summary-line"><strong>原始精确竞价</strong> · ${unbidDeduct ? '全工具补查无竞价（扣减 15 分，记 0 / 15）' : item.reference_bid_usd === null ? '点值参考待补证' : `${single ? '单个主购买词直接参考' : equal ? '主购买词等权参考' : '主入口加权参考'} <strong>US$ ${escape(numberText(item.reference_bid_usd))}</strong>`}</p>${scopeHtml}${deductHtml}
    ${single ? (item.entries[0]?.volume === null || item.entries[0]?.volume === undefined ? '<p class="muted">输入研究记录声明只有一个真实主购买词；本项不需要月搜索量，缺失时保留未知，也不据此推断市场规模。</p>' : '<p class="muted">输入研究记录声明只有一个真实主购买词；本项直接使用该词精确竞价，已记录的月搜索量仅作展示参考，不单独据此推断市场规模。</p>') : ''}
    ${equal ? '<p class="muted">缺少月搜索量；每个主要购买词的可用精准报价均已齐全，因此先合并各词的来源报价，再对全部主购买词等权平均。缺失量保留未知，等权不代表各词需求相同。</p>' : ''}
    <div class="bid-rows">${item.entries.map(entry => `<div class="bid-row"><div class="bid-row-head"><code class="mono-kw">${escape(entry.query)}</code><span class="bid-row-meta">月搜 ${escape(numberText(entry.volume))} · ${entry.source_label === 'sellersprite_only' ? 'SellerSprite 单源精确点' : entry.source_label === 'sif_only' ? 'SIF 单源精确点' : entry.source_label === 'two_source_mean' ? '两源精确点均值' : '可用精确点'} <strong>${entry.combined_point === null ? '未知' : `US$ ${escape(numberText(entry.combined_point))}`}</strong></span></div><p class="muted bid-sub">${['sellersprite', 'sif'].map(source => {
      const reading = object(entry.sources?.[source]);
      const label = source === 'sif'
        ? (reading.tier_used === 'tier2_sif_raise_exact' ? 'SIF 提高和降低／精确' : 'SIF 固定／精确')
        : (reading.channel === 'ss_web' ? 'SellerSprite 网页实时／精确' : 'SellerSprite 精确');
      return `${label} ${reading.point === null || reading.point === undefined ? '未知' : `US$ ${escape(numberText(reading.point))}`}${reading.range ? `（区间 ${escape(rangeText(reading.range))}）` : ''}${reading.point === null && reading.reason ? ` · ${escape(reasonText(reading.reason))}` : ''}`;
    }).join(' ／ ')}</p>${typeof entry.sources?.sif?.strategy_fallback_note === 'string' && entry.sources.sif.strategy_fallback_note ? `<p class="muted">${escape(entry.sources.sif.strategy_fallback_note)}</p>` : ''}${entry.low_exposure_baseline && entry.combined_point !== null ? `<p class="muted">低曝光提示：${escape(string(entry.low_exposure_note, '周曝光极低或无历史数据，采用原生工具返回的平台基准建议竞价。'))}</p>` : ''}</div>`).join('')}</div>${longTailHtml}
    ${Object.entries(object(item.range_scenarios)).filter(([, scenario]) => scenario).map(([source, scenario]) => `<p class="muted">${source === 'sif' ? 'SIF' : 'SellerSprite'}来源区间情景：${single ? '原始建议竞价' : equal ? '等权建议竞价' : '加权建议竞价'} US$ ${escape(rangeText(scenario.bid_range_usd))}，对应评分 ${escape(rangeText(scenario.score_range))}。此区间不替代主点值，不是实际CPC预测。</p>`).join('')}</div>`;
}

function r57NewcomerDetails(result, rev = result?.profile_revision ?? 0) {
  const diagnostics = object(result.diagnostics?.newcomers);
  const pair = array(diagnostics.selected_pair);
  const examples = array(diagnostics.examples);
  const members = array(diagnostics.members);
  const refs = object(diagnostics.references);
  const current = typeof diagnostics.reference_mode === 'string' && /^current_category_r\d+$/.test(diagnostics.reference_mode);
  const pairKeys = new Set(pair.map(entry => `${entry.family_id}\0${entry.asin}`));
  if (rev >= 58) {
    const strat = object(diagnostics.stratification);
    const rampExcl = array(diagnostics.ramp_up_excluded);
    const rampZero = array(diagnostics.ramp_up_zero_sales);
    const denom = diagnostics.denominator;
    const tLead = diagnostics.no_qualifying_examples
      ? escape(string(diagnostics.absence_note, '所查范围内无同任务正常起步新品样板')) + '；少评价与自然曝光各记 0 支持分，不代表无法进入此市场。'
      : `独立类目参照：${escape(numberText(refs.family_count))}个去重家族，近30天销量中位数 T = ${escape(numberText(refs.sales_median))} 件${refs.floor_applied ? `（小类目 10 件保底生效，T_eff = ${escape(numberText(refs.effective_sales_median))} 件）` : ''}。销量粒度：${refs.grain === 'family_representative' ? '每家族一个代表ASIN估算' : refs.grain === 'parent_units' ? '去重父体月销量口径' : '声明的家族销量'}。`;
    const selLead = pair.length
      ? `最终入选样本 S*（${pair.length} 款，分母 D = ${escape(numberText(denom ?? Math.max(pair.length, 2)))}）：${pair.map(entry => escape(`${entry.family_id} / ${entry.asin}`)).join('；')}。`
      : diagnostics.no_qualifying_examples
        ? '保留源样本及排除理由。'
        : '示例尚待核实；缺数据不填零。';
    const policyLine = '<p class="muted">修订58规则：所有满30天同任务正常起步新品强制纳入，未满30天零销量起量前预先排除；未满30天有销新品按精确有理数贪心规则择优并入使 F(S) = sum(e) / max(|S|, 2) 严格提高（持平取最短前缀）；4分项与1分项共用同一 S* 与分母 D。</p>';
    const strataList = array(strat.strata);
    const stratHtml = strat.applied
      ? `<p class="ink-muted"><strong>${escape(strat.disclosure)}</strong>（有效新品池 ${escape(numberText(strat.active_pool_size))} 款，抽检 ${escape(numberText(strat.sampled_count))} 款，分层未抽样 ${escape(numberText(strat.unsampled_count))} 款）；4 分项全集界限 <strong>${escape(rangeText(strat.stratified_bounds))} / 4</strong>。${escape(string(strat.natural_stratified_note))}</p>${strataList.length ? `<details class="quiet-fold"><summary>5 分位分层抽样与替补明细（${strataList.length} 层）</summary><ul>${strataList.map(st => `<li>第 ${escape(numberText((st.stratum ?? 0) + 1))} 层（共 ${escape(numberText(st.count))} 款）：代表 ${st.chosen ? `<span class="mono-id">${escape(st.chosen.family_id)} / ${escape(st.chosen.asin)}</span>` : '无'}${finite(st.borrowed_from_stratum) ? `（本层已空，按固定替补序借调自第 ${escape(numberText(st.borrowed_from_stratum + 1))} 层）` : ''}</li>`).join('')}</ul></details>` : ''}`
      : '';
    const loneHtml = diagnostics.lone_newcomer_alert && diagnostics.lone_newcomer_note
      ? `<p class="ink-fail"><strong>预警：</strong>${escape(diagnostics.lone_newcomer_note)}</p>`
      : '';
    const rampNote = (rampExcl.length || rampZero.length)
      ? `<p class="muted">${rampExcl.length ? `未并入的未满30天有销新品（${rampExcl.length} 款，避免稀释 F(S)）：${rampExcl.map(r => `${escape(r.family_id)}（${escape(numberText(r.age_days))}天，e=${escape(numberText(r.score))}）`).join('；')}。` : ''}${rampZero.length ? `起量前预排除的未满30天零销量新品（${rampZero.length} 款）：${rampZero.map(r => `${escape(r.family_id)}（${escape(numberText(r.age_days))}天）`).join('；')}。` : ''}</p>`
      : '';
    return `<section class="ledger-section"><h3>正常新品：固定示例</h3>
      <p class="section-lead">${tLead}</p>
      <p class="muted">${selLead}</p>
      ${policyLine}
      ${stratHtml}
      ${loneHtml}
      ${rampNote}
      ${examples.length ? `<dl class="kv-rows">${examples.map(example => {
        const raw = members.find(member => member?.family_id === example.family_id && member?.asin === example.asin) ?? {};
        const natural = object(example.natural);
        const ageTag = finite(example.age_days) ? ` · 上架 ${escape(numberText(example.age_days))} 天（${example.is_full_month ? '满30天强制' : '未满30天起量期'}）` : '';
        const revOrigin = rev >= 59
          ? ((raw?.review_origin_breakdown && typeof raw.review_origin_breakdown === 'object')
            ? raw.review_origin_breakdown
            : extractNewcomerReviewOriginBreakdown(raw))
          : null;
        const revOriginText = revOrigin ? (revOrigin.display_zh ?? revOrigin.summary_zh ?? '') : '';
        const revOriginLine = rev >= 59 && typeof revOriginText === 'string' && revOriginText.trim()
          ? `<p class="muted">代表新品评论构成：${escape(revOriginText.trim())}</p>`
          : '';
        return `<div class="kv-row"><dt><span class="mono-id">${escape(example.family_id)}</span>${pairKeys.has(`${example.family_id}\0${example.asin}`) ? ' · 已选示例 S*' : ' · 参照样本'}</dt><dd><div class="kv-main">评价数 ${escape(observed(raw.ratings))} · 近30天销量 ${escape(observed(raw.units_30d))} · 少评价得分 ${escape(numberText(example.score))} / 4${ageTag}</div><p class="muted">实际数量分 ${escape(numberText(example.actual_score))}；销量／参照中位数 ${escape(numberText(example.sales_ratio))}；销量封顶 ${escape(numberText(example.sales_ceiling))}。</p>${revOriginLine}${typeof raw.reason === 'string' ? `<p class="muted">纳入理由：${escape(raw.reason)}</p>` : ''}<p class="muted">自然曝光 ${escape(observed(natural.input))}（${natural.source_label === 'sif_with_sellersprite_corroboration' ? 'SIF占比＋SellerSprite旁证' : 'SIF单来源占比'}）· ${natural.score === null || natural.score === undefined ? escape(reasonText(natural.reason)) : `自然得分 ${escape(numberText(natural.score))} / 1`}${natural.input?.period ? ` · ${escape(readable(natural.input.period))}` : ''}</p>${natural.keyword_counts ? `<p class="muted">自然／广告词数：SellerSprite ${escape(numberText(natural.keyword_counts.sellersprite?.organic))} / ${escape(numberText(natural.keyword_counts.sellersprite?.ad))}；SIF ${escape(numberText(natural.keyword_counts.sif?.organic))} / ${escape(numberText(natural.keyword_counts.sif?.ad))}。</p>` : ''}${natural.coverage_exposure_mismatch && natural.coverage_exposure_diagnosis ? `<p class="ink-fail"><strong>自然诊断：</strong>${escape(natural.coverage_exposure_diagnosis)}</p>` : ''}</dd></div>`;
      }).join('')}</dl>` : ''}
      ${members.some(member => member?.effective_status && member.effective_status !== 'qualified') ? `<details class="quiet-fold"><summary>未纳入新品参照的其他榜单记录（${members.filter(m => m?.effective_status && m.effective_status !== 'qualified').length}）</summary><ul>${members.filter(member => member?.effective_status && member.effective_status !== 'qualified').map(member => `<li><span class="mono-id">${escape(member.family_id ?? member.asin ?? '未命名记录')}</span>（${escape(MEMBER_STATES[member.effective_status] ?? member.effective_status)}）：${escape(reasonText(member.reason))}</li>`).join('')}</ul></details>` : ''}
    </section>`;
  }
  return `<section class="ledger-section"><h3>正常新品：${current ? '固定示例' : '同一对示例'}</h3>
    <p class="section-lead">${current ? diagnostics.no_qualifying_examples ? '当前相关榜单的完整查询中，没有合格近三个月新品；少评价与自然曝光各记0支持分，不代表无法进入此市场。' : `独立类目参照：${escape(numberText(refs.family_count))}个去重家族，近30天销量中位数 ${escape(numberText(refs.sales_median))} 件。参照包含新老商品；不再计算评价数中位数。销量粒度：${refs.grain === 'family_representative' ? '每家族一个代表ASIN估算，不是父体合计' : refs.grain === 'parent_units' ? '去重父体月销量口径' : '声明的家族销量'}。` : `评分数量中位数 ${escape(numberText(refs.rating_median))}；近30天销量中位数 ${escape(numberText(refs.sales_median))}。中位数使用全体观察到的合格参照，包含弱表现与仍合格的退出样本。`}</p>
    <p class="muted">${pair.length ? `固定${pair.length}个示例：${pair.map(entry => escape(`${entry.family_id} / ${entry.asin}`)).join('；')}。${pair.length === 1 ? '这是单例支持，不能理解为普遍成功。' : ''}` : diagnostics.no_qualifying_examples ? '保留源样本及排除理由。' : '示例尚待核实；缺数据不填零。'}</p>
    ${diagnostics.selection_tie_policy === 'complete_score_before_unresolved_equal_bound' ? '<p class="muted">已有两款完整少评价得分时，最多只能同分的缺数样本不再阻断选例；缺数仍是未知。可能超过所选样本的仍需补证。自然可见度继续使用同一组示例。</p>' : ''}
    ${examples.length ? `<dl class="kv-rows">${examples.map(example => {
      const raw = members.find(member => member?.family_id === example.family_id && member?.asin === example.asin) ?? {};
      const natural = object(example.natural);
      return `<div class="kv-row"><dt><span class="mono-id">${escape(example.family_id)}</span>${pairKeys.has(`${example.family_id}\0${example.asin}`) ? ' · 已选示例' : ' · 参照样本'}</dt><dd><div class="kv-main">评价数 ${escape(observed(raw.ratings))} · 近30天销量 ${escape(observed(raw.units_30d))} · 少评价得分 ${escape(numberText(example.score))} / 4</div><p class="muted">实际数量分 ${escape(numberText(example.actual_score))}；${current ? '' : `相对数量分 ${escape(numberText(example.relative_score))}；`}销量／参照中位数 ${escape(numberText(example.sales_ratio))}；销量封顶 ${escape(numberText(example.sales_ceiling))}。</p>${typeof raw.reason === 'string' ? `<p class="muted">纳入理由：${escape(raw.reason)}</p>` : ''}<p class="muted">自然曝光 ${escape(observed(natural.input))}（${natural.source_label === 'sif_with_sellersprite_corroboration' ? 'SIF占比＋SellerSprite旁证' : 'SIF单来源占比'}）· ${natural.score === null || natural.score === undefined ? escape(reasonText(natural.reason)) : `自然得分 ${escape(numberText(natural.score))} / 1`}${natural.input?.period ? ` · ${escape(readable(natural.input.period))}` : ''}</p>${natural.keyword_counts ? `<p class="muted">自然／广告词数：SellerSprite ${escape(numberText(natural.keyword_counts.sellersprite?.organic))} / ${escape(numberText(natural.keyword_counts.sellersprite?.ad))}；SIF ${escape(numberText(natural.keyword_counts.sif?.organic))} / ${escape(numberText(natural.keyword_counts.sif?.ad))}。</p>` : ''}</dd></div>`;
    }).join('')}</dl>` : ''}
    ${members.some(member => member?.effective_status && member.effective_status !== 'qualified') ? `<details class="quiet-fold"><summary>未纳入新品参照的其他榜单记录（${members.filter(m => m?.effective_status && m.effective_status !== 'qualified').length}）</summary><ul>${members.filter(member => member?.effective_status && member.effective_status !== 'qualified').map(member => `<li><span class="mono-id">${escape(member.family_id ?? member.asin ?? '未命名记录')}</span>（${escape(MEMBER_STATES[member.effective_status] ?? member.effective_status)}）：${escape(reasonText(member.reason))}</li>`).join('')}</ul></details>` : ''}
  </section>`;
}

function r57RevenueAllocationStrip(scenarios, rev = 57) {
  const r58 = rev >= 58;
  const valid = scenarios
    .filter(sc => !r58 || isScoredSupportedR58(sc))
    .map(sc => ({
      label: r58 ? sanitizeTextPaths(string(sc?.input?.label, sc?.id ?? '当前情景')) : string(sc?.input?.label, sc?.id ?? '当前情景'),
      calc: sc?.input?.calculation,
      sc,
    }))
    .filter(row => row.calc && finite(row.calc.net_revenue_usd) && row.calc.net_revenue_usd > 0 && finite(row.calc.net_cost_usd));
  if (!valid.length) return '';
  valid.sort((a, b) => (a.calc.margin ?? -Infinity) - (b.calc.margin ?? -Infinity));
  const { label, calc, sc } = valid[0];
  const lines = array(calc.lines);
  const amt = id => {
    const found = lines.find(l => l.id === id);
    return found && !array(calc.deferred_lines).includes(id) && finite(found.amount_usd) ? found.amount_usd : 0;
  };
  const supplyUsd = amt('procurement') + amt('domestic_freight') + amt('headhaul');
  const platformUsd = Math.max(0, calc.net_cost_usd - supplyUsd);
  const netRev = calc.net_revenue_usd;
  const contribUsd = netRev - calc.net_cost_usd;
  const posContrib = Math.max(0, contribUsd);
  const denom = Math.max(netRev, calc.net_cost_usd);
  const supplyPct = Math.min(100, Math.max(0, (supplyUsd / denom) * 100));
  const platformPct = Math.min(100 - supplyPct, Math.max(0, (platformUsd / denom) * 100));
  const marginPct = contribUsd > 0 ? Math.max(0, 100 - supplyPct - platformPct) : 0;
  const pass = rev >= 58 ? calcMeetsFloor30(calc, sc) === true : (finite(calc.margin) && calc.margin >= 0.3);
  const money = v => `US$ ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
  return `<div class="alloc-strip" aria-label="退款后净收入去向构成">
    <div class="alloc-head">
      <span><strong>净收入去向构成</strong> · 保守基准：${escape(label)}（退款后净收入 ${money(netRev)}）</span>
      <span class="muted">70% 成本上限<span class="sep-bar" aria-hidden="true"></span>30% 毛利红线</span>
    </div>
    <div class="alloc-track" aria-hidden="true">
      <span class="alloc-seg alloc-supply" style="width:${supplyPct.toFixed(2)}%"></span>
      <span class="alloc-seg alloc-platform" style="width:${platformPct.toFixed(2)}%"></span>
      ${marginPct > 0 ? `<span class="alloc-seg ${pass ? 'alloc-margin-pass' : 'alloc-margin-fail'}" style="width:${marginPct.toFixed(2)}%"></span>` : ''}
      <span class="alloc-tick" title="30% 广告前净毛利红线（净成本 ≤ 70%）"></span>
    </div>
    <div class="alloc-legend">
      <span><i class="swatch swatch-supply" aria-hidden="true"></i>采购＋国内运＋头程 <strong>${money(supplyUsd)}</strong>（${escape(numberText((supplyUsd / netRev) * 100))}%）</span>
      <span><i class="swatch swatch-platform" aria-hidden="true"></i>佣金＋FBA配送入仓仓储 <strong>${money(platformUsd)}</strong>（${escape(numberText((platformUsd / netRev) * 100))}%）</span>
      <span><i class="swatch ${pass ? 'swatch-pass' : 'swatch-fail'}" aria-hidden="true"></i>广告前留存 <strong>${money(contribUsd)}</strong>（<strong class="${pass ? 'ink-pass' : 'ink-fail'}">${finite(calc.margin) ? `${escape(numberText(calc.margin * 100))}%` : `${escape(numberText((posContrib / netRev) * 100))}%`}</strong>）</span>
    </div>
  </div>`;
}

function r57EconomicWaterfall(result, tableCaptionId, rev = result?.profile_revision ?? 0, original = null) {
  const diagnostics = object(result.diagnostics?.economics);
  const scenarios = array(diagnostics.scenarios);
  if (!scenarios.length) return '';

  const money2 = val => finite(val) ? `US$ ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val)}` : '未知';
  const lineOrder = ['procurement', 'domestic_freight', 'headhaul', 'referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'collection', 'other_applicable', 'returns_disposal', 'recovery_credit'];
  const r58 = rev >= 58;
  const refBidUsd = r58 && finite(result?.diagnostics?.bids?.reference_bid_usd) && result.diagnostics.bids.reference_bid_usd > 0
    ? result.diagnostics.bids.reference_bid_usd : null;
  const stressScenarios = r58 ? array(diagnostics.stress_scenarios) : [];
  const expectedPrimary = r58 && Array.isArray(diagnostics.expected_primary_scenarios) ? diagnostics.expected_primary_scenarios : [];

  const cellAmount = (ledger, lineId) => {
    if (!ledger) return '未知';
    const pending = array(ledger.pending_lines);
    const deferred = array(ledger.deferred_lines);
    const line = array(ledger.lines).find(l => l.id === lineId);
    if (!line) return r58 ? '–' : '—';
    if (deferred.includes(lineId)) return pending.includes(lineId) ? '待补证' : '成对暂缓';
    if (pending.includes(lineId) || line.amount_usd === null) return '待补证';
    return money2(line.amount_usd);
  };

  const r58ExtraRows = r58 ? `
          <tr><th scope="row">保 30% 毛利对应到深含运采购上限<span class="th-note">含采购＋国内运（(0.70×R − A)×FX）；与上方裸货采购上限区分</span></th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            const si = sc.input?.cost_ledger?.source_inputs;
            const fxVal = finite(si?.fx_cny_per_usd) ? si.fx_cny_per_usd : si?.fx_usdcny;
            const cnyCap = finite(c?.landed_domestic_cap_at_30pct_cny)
              ? c.landed_domestic_cap_at_30pct_cny
              : (finite(c?.landed_domestic_cap_at_30pct_usd) && finite(fxVal) && fxVal > 0
                ? c.landed_domestic_cap_at_30pct_usd * fxVal
                : null);
            return finite(c?.landed_domestic_cap_at_30pct_usd)
              ? `<td class="num-col">${money2(c.landed_domestic_cap_at_30pct_usd)}${finite(cnyCap) ? `<span class="th-note">约 ¥${escape(numberText(cnyCap))}</span>` : ''}</td>`
              : '<td class="num-col ink-muted">待补证</td>';
          }).join('')}</tr>${rev >= 59 ? `
          <tr><th scope="row">单件落地本金（采购 + 国内运费 + 头程）<span class="th-note">仅作资金门槛参考，不算强制周转月数</span></th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            const cl = sc.input?.cost_ledger;
            const si = cl?.source_inputs;
            const procLineRaw = array(cl?.lines).find(l => l?.id === 'procurement');
            const domLineRaw = array(cl?.lines).find(l => l?.id === 'domestic_freight');
            const fxVal = [si?.fx_cny_per_usd, si?.fx_usdcny, cl?.fx_cny_per_usd, procLineRaw?.fx_cny_per_usd, domLineRaw?.fx_cny_per_usd]
              .find(v => finite(v) && v > 0) ?? null;
            const pendingSet = new Set(array(c?.pending_lines));
            const procUsd = pendingSet.has('procurement') ? null : array(c?.lines).find(l => l?.id === 'procurement')?.amount_usd;
            const domUsd = pendingSet.has('domestic_freight') ? null : array(c?.lines).find(l => l?.id === 'domestic_freight')?.amount_usd;
            const headUsd = pendingSet.has('headhaul') ? null : array(c?.lines).find(l => l?.id === 'headhaul')?.amount_usd;
            if (!finite(procUsd) || !finite(domUsd) || !finite(headUsd)) {
              return '<td class="num-col ink-muted">待补证</td>';
            }
            const unitUsd = procUsd + domUsd + headUsd;
            const usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(unitUsd);
            if (fxVal !== null) {
              const unitCny = unitUsd * fxVal;
              const cnyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(unitCny);
              const batch100CnyFmt = new Intl.NumberFormat('en-US').format(Math.round(unitCny * 100));
              return `<td class="num-col">≈ ¥${escape(cnyFmt)} / $${escape(usdFmt)}<span class="th-note">按 100 套试算参考本金 ≈ ¥${escape(batch100CnyFmt)}</span></td>`;
            }
            const batch100UsdFmt = new Intl.NumberFormat('en-US').format(Math.round(unitUsd * 100));
            return `<td class="num-col">≈ $${escape(usdFmt)}<span class="th-note">按 100 套试算参考本金 ≈ $${escape(batch100UsdFmt)}</span></td>`;
          }).join('')}</tr>${(() => {
            const rawLabNote = original?.one_time_lab_fee_note ?? original?.compliance_lab_fee_note ?? original?.presentation?.one_time_lab_fee_note ?? null;
            const rawLabUsd = original?.one_time_compliance_fee_usd ?? original?.one_time_lab_fee_usd ?? null;
            if (!rawLabNote && !finite(rawLabUsd)) return '';
            const labText = typeof rawLabNote === 'string' && rawLabNote.trim()
              ? sanitizeTextPaths(rawLabNote.trim())
              : `预估约 US$ ${numberText(rawLabUsd)}（一次性投入，不摊进单件毛利）`;
            return `
          <tr><th scope="row">一次性实验室／合规检测费提醒<span class="th-note">独立列示于首批参考本金旁 · 不摊入单件毛利、不设硬红线</span></th><td class="num-col" colspan="${scenarios.length}">${escape(labText)}</td></tr>`;
          })()}` : ''}${refBidUsd !== null ? `
          <tr><th scope="row">广告盈亏平衡所需点击转化率<span class="th-note">广告订单数 ÷ 广告点击数；仅可与点击转化率 clickConvRate 对照，严禁与搜索购买率 purchaseRate 混比</span></th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            const cond = c?.status === 'sensitivity_only';
            const contrib = cond ? c?.contribution_usd : sc.input?.contribution_usd?.value;
            return finite(contrib) && contrib > 0
              ? `<td class="num-col">${escape(numberText((refBidUsd / contrib) * 100))}%</td>`
              : '<td class="num-col ink-muted">待补证</td>';
          }).join('')}</tr>` : ''}` : '';

  const stressSection = stressScenarios.length ? `
    <div class="quiet-surface" data-section="stress-scenarios">
      <h3>独立压力情景（仅作敏感度观察，不计入 21 项主分与 30% 淘汰线）</h3>
      <dl class="kv-rows">${stressScenarios.map(st => {
        const mText = finite(st.margin) ? `${escape(numberText(st.margin * 100))}%` : '待补证';
        const cText = finite(st.contribution_usd) ? money2(st.contribution_usd) : '待补证';
        const adText = finite(st.advertising_scenario_margin) ? `${escape(numberText(st.advertising_scenario_margin * 100))}%` : '待补证';
        const capCny = finite(st.landed_domestic_cap_at_30pct_cny) ? `（约 ¥${escape(numberText(st.landed_domestic_cap_at_30pct_cny))}）` : '';
        const capText = finite(st.landed_domestic_cap_at_30pct_usd) ? `；保30%到深含运上限 ${money2(st.landed_domestic_cap_at_30pct_usd)}${capCny}` : '';
        const issues = array(st.stress_issues);
        const issuesHtml = issues.length
          ? `<p class="${st.double_deduction_blocked ? 'ink-fail' : 'muted'}"><strong>压力情景核查提示：</strong>${issues.map(iss => escape(sanitizeTextPaths(string(iss?.reason ?? iss)))).join('；')}</p>`
          : '';
        return `<div class="kv-row"><dt>${escape(sanitizeTextPaths(string(st.label ?? st.id, '压力情景')))}</dt><dd><div class="kv-main">压力售价 ${money2(st.price_usd)} · 广告前毛利率 ${mText} · 单件贡献 ${cText} · 扣15%广告后 ${adText}${capText}</div>${issuesHtml}${array(st.assumptions).length ? `<p class="muted">${st.assumptions.map(a => escape(readableSanitized(a))).join('；')}</p>` : ''}</dd></div>`;
      }).join('')}</dl>
    </div>` : '';

  const expectedPrimaryNote = expectedPrimary.length ? `<p class="muted">预声明主情景核验：${expectedPrimary.map(e => `${escape(e.id)}（${e.verdict === 'present' ? '已纳入' : e.verdict === 'evidenced_cancellation' ? `有据撤销：${escape(sanitizeTextPaths(string(e.reason)))}` : escape(e.verdict)}）`).join('；')}。</p>` : '';

  return `<section class="ledger-section">
    <div class="section-head"><h3>单件利润与费用拆解</h3><span class="muted">可售单位：${escape(diagnostics.saleable_unit ?? '未知')}</span></div>
    ${r57RevenueAllocationStrip(scenarios, rev)}
    <div tabindex="0" role="region" aria-labelledby="${escape(tableCaptionId)}" class="table-scroll">
      <table class="hairline-table waterfall-table">
        <caption id="${escape(tableCaptionId)}" class="sr-only">各情景单件收入、成本与毛利率对比</caption>
        <thead>
          <tr>
            <th scope="col">核算项目</th>
            ${scenarios.map(sc => {
              const calc = sc.input?.calculation;
              const cond = calc?.status === 'sensitivity_only';
              const rawLabel = string(sc.input?.label, sc.id ?? '未命名情景');
              const dispLabel = r58 ? sanitizeTextPaths(rawLabel) : rawLabel;
              return `<th scope="col" class="num-col">${escape(dispLabel)}${cond ? '<span class="th-note">条件试算·不计分</span>' : ''}</th>`;
            }).join('')}
          </tr>
        </thead>
        <tbody>
          <tr><th scope="row">美站销售定价</th>${scenarios.map(sc => `<td class="num-col"><strong>${money2(sc.input?.calculation?.price_usd)}</strong></td>`).join('')}</tr>
          <tr><th scope="row">退货率代理 ／ 退款后净收入</th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            return `<td class="num-col">${finite(c?.refund_fraction) ? `${escape(numberText(c.refund_fraction * 100))}%` : '未知'} ／ ${money2(c?.net_revenue_usd)}</td>`;
          }).join('')}</tr>
          ${lineOrder.map(lineId => {
            const allDeferred = scenarios.every(sc => array(sc.input?.calculation?.deferred_lines).includes(lineId) && !array(sc.input?.calculation?.pending_lines).includes(lineId));
            const allZero = scenarios.every(sc => {
              const l = array(sc.input?.calculation?.lines).find(x => x.id === lineId);
              return l && l.amount_usd === 0 && !array(sc.input?.calculation?.pending_lines).includes(lineId);
            });
            return `<tr class="${allDeferred || allZero ? 'row-dim' : ''}"><th scope="row">${escape(COST_LABELS[lineId] ?? lineId)}</th>${scenarios.map(sc => `<td class="num-col">${cellAmount(sc.input?.calculation, lineId)}</td>`).join('')}</tr>`;
          }).join('')}
          <tr class="row-sum"><th scope="row">单件完整总费用</th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            return `<td class="num-col"><strong>${c?.net_cost_usd === null || c?.net_cost_usd === undefined ? '未知' : money2(c.net_cost_usd)}</strong></td>`;
          }).join('')}</tr>
          <tr class="row-sum"><th scope="row">广告前单件贡献</th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            const cond = c?.status === 'sensitivity_only';
            const contrib = cond ? c?.contribution_usd : sc.input?.contribution_usd?.value;
            return `<td class="num-col"><strong>${finite(contrib) ? money2(contrib) : '未知'}</strong></td>`;
          }).join('')}</tr>
          <tr class="row-sum"><th scope="row">退款调整后广告前毛利率（门槛 30%）</th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            const cond = c?.status === 'sensitivity_only';
            const m = cond ? { value: c.margin, unit: 'fraction' } : sc.input?.margin;
            const pass30 = r58
              ? (isScoredSupportedR58(sc) && finite(m?.value) ? calcMeetsFloor30(c, sc) : null)
              : (finite(m?.value) ? m.value >= 0.3 : null);
            const tone = pass30 === true ? 'ink-pass' : pass30 === false ? 'ink-fail' : 'ink-muted';
            return `<td class="num-col ${tone}"><strong>${escape(observed(m))}</strong></td>`;
          }).join('')}</tr>
          <tr><th scope="row">扣 15% 广告费后净毛利 ／ 贡献</th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            return finite(c?.advertising_scenario_margin) && finite(c?.advertising_scenario_contribution_usd)
              ? `<td class="num-col">${escape(numberText(c.advertising_scenario_margin * 100))}%（${money2(c.advertising_scenario_contribution_usd)}）</td>`
              : '<td class="num-col ink-muted">待补证</td>';
          }).join('')}</tr>
          <tr><th scope="row">保 30% 毛利对应采购单价上限</th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            return finite(c?.procurement_cap_at_30pct_usd)
              ? `<td class="num-col">${money2(c.procurement_cap_at_30pct_usd)}</td>`
              : '<td class="num-col ink-muted">待补证</td>';
          }).join('')}</tr>${r58ExtraRows}
        </tbody>
      </table>
    </div>${expectedPrimaryNote}${stressSection}
    <div class="scenario-folds">${scenarios.map(scenario => {
      const calculation = scenario.input?.calculation;
      const conditional = calculation?.status === 'sensitivity_only';
      const validation = object(calculation?.fee_validation);
      const context = object(validation.context);
      const windowText = window => window ? `${window.from} 至 ${window.through}` : '待补证';
      const explanation = conditional ? '费用已算出，但售价或其他情景假设尚未确认；不授予经济分。' :
        scenario.coherence_supported === true && scenario.margin_eligible === true ? '该情景满足毛利条件。' :
          calculation && !calculation.scoring_supported ? `完整费用尚待补证：${array(calculation.pending_lines).map(id => COST_LABELS[id] ?? id).join('、') || '费率适用日期或来源'}。见下方核对。` :
            reasonText(scenario.eligibility_reason ?? scenario.margin?.reason ?? '该情景尚不满足或尚不能判断毛利条件。');
      const adNote = calculation && finite(calculation.advertising_scenario_margin) && finite(calculation.advertising_scenario_contribution_usd)
        ? `售价15%广告敏感度参考（US$ ${escape(numberText(calculation.advertising_15pct_usd))}）：广告后单件贡献 US$ ${escape(numberText(calculation.advertising_scenario_contribution_usd))}，广告后毛利率 ${escape(numberText(calculation.advertising_scenario_margin * 100))}%${finite(calculation.procurement_cap_at_30pct_usd) ? `；30%广告前毛利对应采购单价上限 US$ ${escape(numberText(calculation.procurement_cap_at_30pct_usd))}` : ''}（仅作敏感度参考，不改变主毛利计分）。`
        : '';
      const retComp = r58 ? calculation?.returns_processing_components : null;
      const retNote = retComp
        ? `退货费口径：退款率 r_refund=${escape(numberText(retComp.r_refund * 100))}%，实物退货率 r_physical=${escape(numberText(retComp.r_physical * 100))}%${retComp.return_threshold !== null ? `，类目阈值 ${escape(numberText(retComp.return_threshold * 100))}%` : ''}，超阈费 US$ ${escape(numberText(retComp.expected_fee_per_shipped_unit_usd))}。`
        : '';
      const foldTitle = r58 ? sanitizeTextPaths(string(scenario.input?.label, scenario.id ?? '未命名情景')) : string(scenario.input?.label, scenario.id ?? '未命名情景');
      const winSep = r58 ? '·' : '—';
      return `<details class="quiet-fold"><summary>${escape(foldTitle)} · ${escape(explanation)}</summary><div class="fold-body">${calculation ? `<p class="muted">适用窗口 ${winSep} 销售：${escape(windowText(context.sales))}；仓储：${escape(windowText(context.storage))}；入库：${escape(windowText(context.inbound))}。费率核验：${validation.status === 'validated' ? '通过' : '存在待补证项'}。</p>` : ''}${adNote ? `<p class="muted">${adNote}</p>` : ''}${retNote ? `<p class="muted">${retNote}</p>` : ''}${array(validation.issues).length ? `<ul>${validation.issues.map(issue => `<li><strong>${escape(COST_LABELS[issue.line] ?? '费用情景')}</strong>：${escape(issue.code === 'domestic_quote_required' ? (r58 ? '修订58要求提供整数 order_units >= 100 的非首单常规复购货款与国内运费报价（且须与 source_inputs/sku_lines 口径一致，first_order_promotion: false）。' : '需要100采购单位的非首单常规复购货款与国内运费报价（须明确order_units: 100及first_order_promotion: false），不能沿用旧暂缓规则或首单促销减免。') : (FEE_ISSUES[issue.code] ?? (r58 ? sanitizeTextPaths(string(issue.reason)) : issue.reason)))}</li>`).join('')}</ul>` : ''}${array(scenario.input?.assumptions).length ? `<ul>${scenario.input.assumptions.map(value => `<li>${escape(r58 ? readableSanitized(value) : readable(value))}</li>`).join('')}</ul>` : ''}</div></details>`;
    }).join('')}</div>
  </section>`;
}

function r57ScoreRows(result, registry, prefix, rev = result?.profile_revision ?? 0) {
  const r58 = rev >= 58;
  const newcomerDiag = object(result.diagnostics?.newcomers);
  return `<div class="score-columns">${array(result.groups).map(group => {
    const rows = array(result.items).filter(item => item.group === group.id);
    const gTitle = escape(GROUP_LABELS[group.id] ?? group.id);
    return `<section class="score-group" data-group-id="${escape(group.id)}">
      <div class="group-bar">
        ${r58 ? `<strong class="group-title">${gTitle}</strong>` : `<h3>${gTitle}</h3>`}
        <span class="group-pts">${escape(rangeText(group.supported_range))} / ${escape(numberText(group.weight))} <span class="muted">（覆盖 ${escape(numberText(group.covered_weight))}）</span></span>
      </div>
      <div class="group-list">${rows.map(item => {
        const scored = item.status === 'scored' && Array.isArray(item.score_range);
        const scoreCls = scored ? '' : item.status === 'ineligible' ? 'ink-fail' : 'ink-muted';
        const r58Q31Inline = r58 && (item.id === 'low_rating_sales_performance' || item.id === 'natural_visibility_development')
          ? [
            typeof item.absence_note === 'string' && item.absence_note ? `<p class="muted">${escape(item.absence_note)}</p>` : '',
            rev >= 59 && item.id === 'low_rating_sales_performance' && typeof item.rolling_source_disclosure === 'string' && item.rolling_source_disclosure
              ? `<p class="muted">${escape(item.rolling_source_disclosure)}</p>`
              : '',
            typeof item.stratified_disclosure === 'string' && item.stratified_disclosure
              ? `<p class="muted"><strong>${escape(item.stratified_disclosure)}</strong>${Array.isArray(item.stratified_bounds) ? `（全集界限 ${escape(rangeText(item.stratified_bounds))} / 4）` : ''}${typeof item.stratified_note === 'string' && item.stratified_note ? ` · ${escape(item.stratified_note)}` : ''}</p>`
              : '',
            item.id === 'low_rating_sales_performance' && newcomerDiag.lone_newcomer_alert && typeof newcomerDiag.lone_newcomer_note === 'string'
              ? `<p class="ink-fail"><strong>预警：</strong>${escape(newcomerDiag.lone_newcomer_note)}</p>`
              : '',
          ].join('')
          : '';
        const itemTitle = escape(ITEM_LABELS[item.id] ?? item.id);
        return `<div class="item-row" data-item-id="${escape(item.id)}">
          <div class="item-heading">
            ${r58 ? `<strong class="item-title">${itemTitle}</strong>` : `<h4>${itemTitle}</h4>`}
            <p class="item-score ${scoreCls}">${scored ? `${escape(rangeText(item.score_range))} / ${escape(numberText(item.weight))} 分` : item.status === 'ineligible' ? '当前情景不适用合格评分' : '待补证'}</p>
          </div>
          <p class="item-input">${escape(inputSummary(item, rev))}</p>${r58Q31Inline}
          ${item.reason ? `<p class="item-reason">${escape(reasonText(item.reason))}</p>` : ''}
          ${item.conditional_range ? `<p class="muted">固定前提下可能范围：${escape(rangeText(item.conditional_range))}；不是已获得分数。</p>` : ''}
          ${item.id === 'relevant_purchase_entry_bid' ? r57BidDetails(item) : ''}
          ${QUALIFIERS[item.id] ? `<p class="muted item-qualifier">${escape(QUALIFIERS[item.id])}</p>` : ''}
          ${array(item.evidence).length > 4 ? `<details class="cite-fold"><summary>原始依据（${array(item.evidence).length}）</summary><p class="source">依据：${evidenceLinks(item.evidence, registry, prefix)}</p></details>` : `<p class="source">依据：${evidenceLinks(item.evidence, registry, prefix)}</p>`}
        </div>`;
      }).join('')}</div>
    </section>`;
  }).join('')}</div>`;
}

function r57Bibliography(registry, prefix) {
  if (!registry.length) return '<p class="muted">尚未提供可核验的来源记录。</p>';
  return `<ol class="bibliography">${registry.map((entry, index) => `<li id="${prefix}-e${index}"><div class="bib-head"><strong>${sourceLink(string(entry?.source, '未命名来源'), entry?.url ?? entry?.source)}</strong><span class="bib-meta">${escape(typeof entry?.observed_at === 'string' && entry.observed_at.trim() ? entry.observed_at : '日期未知')} · <code class="mono-id">${escape(typeof entry?.id === 'string' ? entry.id : '未知')}</code></span></div>${entry?.scope ? `<p>${escape(sanitizeTextPaths(string(entry?.scope)))}</p>` : ''}${typeof (entry?.path ?? entry?.local_path) === 'string' && (entry?.path ?? entry?.local_path).trim() ? `<p class="source">本地记录：<code class="mono-id">${escape(sanitizeLocalPath(entry.path ?? entry.local_path))}</code></p>` : ''}${entry?.limitations ? `<p class="muted">限制：${escape(readableSanitized(entry.limitations))}</p>` : ''}</li>`).join('')}</ol>`;
}

function r57DiscoveryDetails(discovery, registry, prefix, rev = 0) {
  const kwLeads = array(discovery?.leads);
  const storeLeads = rev >= 58 ? array(discovery?.store_leads) : [];
  if (!discovery || (!kwLeads.length && !storeLeads.length)) return '';
  const kwSep = rev >= 58 ? '·' : '—';
  const kwHtml = kwLeads.length
    ? `<section class="ledger-section"><h3>如何发现这款 · ${escape(kwLeads.length)} 个来源词</h3><p><strong>${escape(discovery.label)}</strong>：${escape(discovery.description)}</p><p class="source">款式实物依据：${evidenceLinks(discovery.offer_evidence, registry, prefix)}</p><ul class="lead-list">${kwLeads.map(lead => `<li><code class="mono-kw">${escape(lead?.keyword)}</code>${typeof lead?.reason === 'string' ? ` ${kwSep} ${escape(lead.reason)}` : ''}<ul>${array(lead?.provenance).map(source => `<li class="source">${escape(source?.source_label ?? source?.source_id)} · ${escape(source?.source_period ?? '期间未返回')}；原始记录：<code class="mono-id">${escape(sanitizeLocalPath(source?.source_path))}</code>，行索引 ${escape(source?.row_index)}${finite(source?.searches) ? `；搜索量 ${escape(numberText(source.searches))}${typeof source.search_units === 'string' ? `（${escape(source.search_units === 'provider_monthly_search_estimate' ? '来源月估算' : source.search_units)}）` : ''}` : '；搜索量未返回'}。</li>`).join('')}</ul></li>`).join('')}</ul><p class="muted">不同来源的搜索量不相加；这些是发现线索，具体得分仍看21项证据。</p></section>`
    : '';
  const storeHtml = storeLeads.length
    ? `<section class="ledger-section" data-section="store-discovery-provenance"><h3>多通道线索来源（SQLite 绑定 · ${escape(storeLeads.length)} 条）</h3><ul class="lead-list">${storeLeads.map(sl => {
      const routeTag = [sl.route, sl.channel_id, sl.opportunity_type, sl.promotion_track].filter(Boolean).join(' / ');
      const roleLabel = sl.link_role === 'primary_discovery' ? '主发现线索' : '辅助旁证';
      const refHtml = safeHttpUrl(sl.source_ref) ? sourceLink(sl.source_ref, sl.source_ref) : escape(sanitizeTextPaths(string(sl.source_ref, '未提供引用')));
      const excerpt = sl.raw_excerpt || sl.verbatim_excerpt;
      return `<li><strong>${escape(sl.phrase_or_title ?? sl.lead_id)}</strong> · <span class="mono-id">${escape(routeTag || sl.source_channel || '未标注通道')}</span> · ${escape(roleLabel)}（${escape(sl.disposition ?? 'pending')}）<p class="source">来源引用：${refHtml}${sl.observed_at ? ` · 观察日 ${escape(sl.observed_at)}` : ''}</p>${excerpt ? `<p class="muted">原话摘录：${escape(sanitizeTextPaths(excerpt))}</p>` : ''}</li>`;
    }).join('')}</ul><p class="muted">非关键词／站外／1688 工厂冷启动与供需错配线索独立保留溯源，不替代 21 项证据计分。</p></section>`
    : '';
  return `${kwHtml}${storeHtml}`;
}

function r57ContactSheetFigure(presentation, label, rev = 0) {
  if (rev < 58) return '';
  const sheet = imageUri(presentation?.contact_sheet_data_uri);
  if (!sheet) return '';
  const caption = string(presentation?.contact_sheet_caption, '4×4 类目视觉聚类联系表（用于确认同形态同任务可比集与价位带切分）');
  return `<section class="ledger-section" data-section="contact-sheet"><h3>视觉聚类联系表（4×4）</h3><figure class="contact-sheet-frame"><img src="${escape(sheet)}" alt="${escape(string(presentation?.contact_sheet_alt, `${label} 视觉聚类联系表`))}" loading="lazy" decoding="async"><figcaption>${escape(caption)}</figcaption></figure></section>`;
}

function r57OperationalDisclosures(result, rev = 0) {
  if (rev < 58) return '';
  const items = array(result?.diagnostics?.operational_disclosures);
  if (!items.length) return '';
  const alertCount = items.filter(i => i?.status === 'alert').length;
  const toneOf = s => s === 'alert' ? 'fail' : s === 'needs_check' ? 'pending' : (s === 'clear' || s === 'disclosed') ? 'pass' : 'muted';
  const labelOf = s => ({ alert: '需排雷', needs_check: '待核查', clear: '已核无碍', disclosed: '已披露', unverified: '待补参数' }[s] ?? '待补参数');
  return `<section class="ledger-section" data-section="operational-disclosures"><details class="quiet-fold"${alertCount > 0 ? ' open' : ''}><summary>运营排雷与实操核查（6 项零否决披露 · ${alertCount > 0 ? `${alertCount} 项预警` : '无即时红旗'}）</summary><div class="fold-body"><dl class="kv-rows">${items.map(item => `<div class="kv-row"><dt>${escape(string(item?.label, item?.id ?? '核查项'))}</dt><dd><div class="kv-main"><span class="state-inline state-${toneOf(item?.status)}"><i class="dot" aria-hidden="true"></i>${escape(labelOf(item?.status))}</span></div><p class="muted">${escape(sanitizeTextPaths(string(item?.note, '待下单前确认。')))}</p></dd></div>`).join('')}</dl><p class="muted">以上 6 项仅作下单前实操排雷披露，不改变 21 项评分与 30% 毛利筛线。</p></div></details></section>`;
}

function r57ReviewNotes(result, original, rev = 0) {
  if (rev < 58) return '';
  const notes = array(result?.review_notes ?? original?.review_notes);
  if (!notes.length) return '';
  return `<section class="quiet-surface" data-section="review-notes"><h3>独立复核与校准备注（CALIBRATION_NOTE）</h3><ul class="brief-list">${notes.map(n => {
    if (typeof n === 'string') return `<li>${escape(sanitizeTextPaths(n))}</li>`;
    const head = [n?.kind ?? n?.tag, n?.reviewer, n?.observed_at ?? n?.date].filter(Boolean).join(' · ');
    const body = sanitizeTextPaths(string(n?.note ?? n?.text ?? readableSanitized(n)));
    return `<li>${head ? `<strong>${escape(head)}：</strong>` : ''}${escape(body)}</li>`;
  }).join('')}</ul></section>`;
}

function r57NegotiationAppendix(result, batch, rev = 0) {
  if (rev !== 58) return '';
  const rawList = [];
  for (const item of [...array(result?.negotiation_shortlist), ...array(batch?.negotiation_shortlist)]) {
    if (!item || typeof item !== 'object') continue;
    rawList.push(item);
  }
  for (const cand of array(result?.candidates)) {
    if (cand?.negotiation_shortlist && typeof cand.negotiation_shortlist === 'object') {
      rawList.push({ candidate_id: cand.candidate_id, label: cand.label ?? cand.candidate_id, ...cand.negotiation_shortlist });
    }
  }
  const seen = new Set();
  const keyOf = item => String(item.candidate_id ?? item.form_id ?? item.label ?? JSON.stringify(item));
  const discOf = item => (finite(item.required_discount_fraction) ? item.required_discount_fraction : item.required_reduction_fraction);
  const eligible = rawList
    .filter(item => {
      if (item.eligible === false) return false;
      if (item.specific_rights_conflict === true || item.rights_conflict === true) return false;
      const d = discOf(item);
      if (!finite(d) || d <= 0 || d > 0.12) return false;
      if (finite(item.price_usd) && item.price_usd < 29.99) return false;
      const key = keyOf(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (discOf(a) - discOf(b)) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
    .slice(0, 2);
  if (!eligible.length) return '';
  return `<section class="method-section" data-section="negotiation-shortlist" aria-labelledby="neg-heading"><h2 id="neg-heading" class="sr-only">议价备选附录</h2><details class="quiet-fold batch-context"><summary>差额 ≤12% 议价备选附录（Top ${eligible.length}，默认折叠 · 未通过 30% 硬线，不计入达标卡）</summary><div class="fold-body"><dl class="kv-rows">${eligible.map(item => {
    const disc = (item.required_discount_fraction ?? item.required_reduction_fraction) * 100;
    const title = sanitizeTextPaths(string(item.label ?? item.candidate_id ?? item.form_id, '备选规格'));
    const curCost = finite(item.current_cost_usd) ? `当前可议价成本 US$ ${escape(numberText(item.current_cost_usd))}` : '';
    const tgtCost = finite(item.target_cost_usd) ? `目标成本 US$ ${escape(numberText(item.target_cost_usd))}` : '';
    const note = typeof item.note === 'string' ? sanitizeTextPaths(item.note) : '';
    return `<div class="kv-row"><dt>${escape(title)}</dt><dd><div class="kv-main">需压价 <strong>${escape(numberText(disc))}%</strong>${curCost || tgtCost ? `（${[curCost, tgtCost].filter(Boolean).join(' → ')}）` : ''}</div>${note ? `<p class="muted">${escape(note)}</p>` : ''}</dd></div>`;
  }).join('')}</dl><p class="muted">仅收录无权利冲突、售价 ≥$29.99 且采购降幅 ≤12% 即可跨过 30% 红线的 Top 1–2 款；必须先拿厂方确认降价再重算入卡。</p></div></details></section>`;
}

function r59PackagingRedesignAppendix(result, batch, rev = 0) {
  if (rev < 59) return '';
  const nonExcludedR59Ids = new Set(
    array(result?.candidates)
      .filter(c => c?.effective_disposition !== 'hard_excluded' && c?.queue !== 'excluded')
      .map(c => c?.candidate_id ?? c?.id)
      .filter(Boolean),
  );
  const rawList = [];
  for (const item of [...array(result?.packaging_redesign_shortlist), ...array(batch?.packaging_redesign_shortlist)]) {
    if (!item || typeof item !== 'object') continue;
    const itemFid = item.candidate_id ?? item.form_id ?? item.id ?? null;
    if (itemFid && nonExcludedR59Ids.has(itemFid)) continue;
    rawList.push(item);
  }
  for (const cand of array(result?.candidates)) {
    if (cand?.effective_disposition !== 'hard_excluded' && cand?.queue !== 'excluded') continue;
    if (cand?.packaging_redesign_shortlist && typeof cand.packaging_redesign_shortlist === 'object') {
      rawList.push({ candidate_id: cand.candidate_id, label: cand.label ?? cand.candidate_id, ...cand.packaging_redesign_shortlist });
    }
  }
  const seen = new Set();
  const keyOf = item => String(item.candidate_id ?? item.form_id ?? item.label ?? JSON.stringify(item));
  const trimMarginOf = item => item?.redesigned_margin ?? item?.trimmed_margin;
  const eligible = rawList
    .filter(item => {
      if (item.eligible !== true) return false;
      if (item.specific_rights_conflict === true || item.rights_conflict === true) return false;
      const effPrice = item.price_usd ?? item.effective_price_usd;
      if (finite(effPrice) && effPrice < 29.99) return false;
      if (!finite(item.overshoot_mm) || item.overshoot_mm <= 0 || item.overshoot_mm > 10.0001) return false;
      const tm = trimMarginOf(item);
      if (!finite(tm) || tm < 0.30) return false;
      const key = keyOf(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.overshoot_mm - b.overshoot_mm) || (trimMarginOf(b) - trimMarginOf(a)) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  if (!eligible.length) return '';
  const sideLabelOf = s => ({ longest: '最长边', median: '次长边', shortest: '最短边' }[s] ?? string(s, '单边'));
  return `<section class="method-section" data-section="packaging-redesign-shortlist" aria-labelledby="pkg-redesign-heading"><h2 id="pkg-redesign-heading" class="sr-only">改包装可救提醒池</h2><details class="quiet-fold batch-context" open><summary>单边压线 ≤10 mm 改包装可救提醒池（${eligible.length} 款 · 原包装主毛利仍如实按 &lt;30% 记录，不计入达标卡）</summary><div class="fold-body"><dl class="kv-rows">${eligible.map(item => {
    const title = sanitizeTextPaths(string(item.label ?? item.candidate_id ?? item.form_id, '压线可救款式'));
    const origM = finite(item.original_margin) ? `${escape(numberText(item.original_margin * 100))}%` : '未知';
    const trimM = `${escape(numberText(trimMarginOf(item) * 100))}%`;
    const sideTxt = typeof item.offending_side_label_zh === 'string' && item.offending_side_label_zh.trim()
      ? item.offending_side_label_zh.trim()
      : sideLabelOf(item.offending_role ?? item.offending_side);
    const mmTxt = escape(numberText(item.overshoot_mm));
    const savTxt = finite(item.fba_fee_savings_usd) ? `降档省 FBA 费 US$ ${escape(numberText(item.fba_fee_savings_usd))}` : '';
    const targetTier = item.target_size_tier ?? item.trimmed_size_tier;
    const tierTxt = item.original_size_tier && targetTier ? `${escape(string(item.original_size_tier))} → ${escape(string(targetTier))}` : '';
    const rawNote = typeof item.summary_zh === 'string' && item.summary_zh.trim() ? item.summary_zh : item.note;
    const note = typeof rawNote === 'string' ? sanitizeTextPaths(rawNote) : '';
    return `<div class="kv-row"><dt>${escape(title)}</dt><dd><div class="kv-main">${escape(sideTxt)}超差 <strong>${mmTxt} mm</strong>（≤10 mm 红线）${tierTxt ? ` · ${tierTxt}` : ''}${savTxt ? ` · ${savTxt}` : ''} · 原包装毛利 <strong>${origM}</strong> → 压缩后 2027 淡季毛利 <strong>${trimM}</strong></div>${note ? `<p class="muted">${escape(note)}</p>` : ''}</dd></div>`;
  }).join('')}</dl><p class="muted">死红线：仅收录无权利冲突、售价 ≥$29.99、单边超出 FBA 分档边界 ≤10 mm（1 cm）导致跳档且压缩后 2027 淡季毛利率 ≥30% 的款式；超出 &gt;10 mm 或压完仍 &lt;30% 的直接淘汰，交由主人看实物结构拍板。</p></div></details></section>`;
}

function r57DiscoverySummary(summary) {
  if (!summary || !finite(summary.unique_keywords)) return '';
  const seasonal = summary.dispositions?.seasonal_deferred ?? 0;
  return `<p class="batch-counts">来源词 ${escape(numberText(summary.unique_keywords))} 个；已核对 ${escape(numberText(summary.reviewed_keywords))} 个，待核 ${escape(numberText(summary.pending_keywords - seasonal))} 个，暂缓 ${escape(numberText(seasonal))} 个，搁置专属或无关搜索 ${escape(numberText(summary.excluded_keywords))} 个；已绑定实物候选 ${escape(numberText(summary.bound_candidates))} 个。词数不等于产品数，绑定不代表评分通过。</p>`;
}

function r57PeriodPanel(period, presentation, registry, prefix, panelIndex, rev = period?.profile_revision ?? 0) {
  const complete = period.queue === 'comparable' && Array.isArray(period.total_range);
  const gaps = array(period.items).filter(item => item.status === 'needs_evidence');
  const ineligible = array(period.items).filter(item => item.status === 'ineligible');
  const conditions = array(period.screening?.conditions).filter(condition => condition.status !== 'pass');
  const economics = object(period.diagnostics?.economics);
  const periodScenarios = array(economics.scenarios);
  const contributions = periodScenarios.map(scenario => scenario?.contribution?.value);
  const contribution = contributions.length && contributions.every(finite) && (rev < 58 || periodScenarios.every(isScoredSupportedR58))
    ? [Math.min(...contributions), Math.max(...contributions)]
    : null;
  const margin = array(economics.margin_range).length === 2 ? economics.margin_range.map(value => value * 100) : null;
  const label = { excluded: '本时段排除', deferred: '本时段暂缓' }[period.queue] ?? QUEUES[period.queue] ?? '待补证';
  const incomplete = period.queue === 'excluded' ? '本经营时段不满足筛选条件，不列完整总分' :
    period.queue === 'deferred' ? '本经营时段暂缓，不列完整总分' : '本经营时段完整总分待补证';
  return `<section class="operating-period tab-panel tab-p${panelIndex}" data-operating-period="${escape(period.id)}" data-queue="${escape(period.queue)}">
    <div class="period-meta-line">
      <div>
        <strong>${escape(period.label)}</strong> · <span class="muted">${label} · 适用 ${escape(array(period.months).join('、'))}月</span>
        ${typeof presentation.summary === 'string' ? `<p class="period-note">${escape(presentation.summary)}</p>` : ''}
      </div>
      <div class="period-inline-nums">
        <span>毛利 <strong>${margin ? `${escape(rangeText(margin))}%` : '未知'}</strong></span>
        <span>贡献 <strong>${contribution ? `US$ ${escape(rangeText(contribution))}` : '未知'}</strong></span>
        <span>总分 <strong>${complete ? `${escape(rangeText(period.total_range))} / 100` : incomplete}</strong></span>
      </div>
    </div>
    <p class="muted coverage-line">已支持分数 ${escape(rangeText(period.supported_range))}；已计分权重 ${escape(numberText(period.covered_weight))} / 100；不满足合格评分条件 ${ineligible.length} 项；待补证 ${gaps.length} 项。${period.conditional_total_range ? `满足本时段准入后可能范围 ${escape(rangeText(period.conditional_total_range))}（数学界限，非预测）。` : ''}</p>
    ${conditions.length ? `<p class="muted coverage-line">本时段筛选：${conditions.map(condition => `${escape(STATES[condition.status] ?? condition.status)}：${escape(reasonText(condition.reason))}`).join('；')}</p>` : ''}
    ${r57KeyValueSection('本时段核算参数', presentation.facts)}
    ${r57EconomicWaterfall(period, `${prefix}-econ-${period.id}`, rev)}
    <section class="ledger-section">
      <div class="section-head"><h3>21 项评分明细</h3><span class="muted">8 大维度 · 点击编号直达原始证据</span></div>
      ${r57ScoreRows(period, registry, prefix, rev)}
    </section>
    ${r57NewcomerDetails(period, rev)}
  </section>`;
}

function renderLeftSpecLedger(snapshot, queueLabel, rev = 57) {
  const r58 = rev >= 58;
  const marginCls = r58
    ? (snapshot.marginFloorStatus === 'pass' ? 'ink-pass' : snapshot.marginFloorStatus === 'fail' ? 'ink-fail' : snapshot.marginFloorStatus === 'cross' ? '' : 'ink-muted')
    : (snapshot.margins
      ? (snapshot.margins[0] >= 0.3 ? 'ink-pass' : snapshot.margins[1] < 0.3 ? 'ink-fail' : '')
      : 'ink-muted');
  let deltaHtml = `<span class="muted">${snapshot.isSensitivity ? '同精度条件试算 · 红线 30%' : '广告前净毛利率 · 红线 30%'}</span>`;
  if (snapshot.margins) {
    if (r58 ? snapshot.marginFloorStatus === 'pass' : snapshot.margins[0] >= 0.3) {
      const pts = r58 ? Math.max(0, (snapshot.margins[0] - 0.3) * 100) : (snapshot.margins[0] - 0.3) * 100;
      deltaHtml = `<span class="ink-pass">${SVG_UP} +${escape(numberText(pts))} pts 高于红线</span> · <span class="muted">广告前净毛利</span>`;
    } else if (r58 ? snapshot.marginFloorStatus === 'fail' : snapshot.margins[1] < 0.3) {
      const pts = (snapshot.margins[1] - 0.3) * 100;
      deltaHtml = `<span class="ink-fail">${SVG_DOWN} ${escape(numberText(pts))} pts 低于红线</span> · <span class="muted">${snapshot.isSensitivity ? '同精度试算' : '广告前净毛利'}</span>`;
    }
  }
  const domesticMain = snapshot.cnyTotals
    ? `${escape(rangeText(snapshot.cnyTotals))} 元`
    : usdRangeText(snapshot.domesticDelivered);
  const domesticSub = snapshot.cnyTotals && snapshot.domesticDelivered
    ? `（${usdRangeText(snapshot.domesticDelivered)}）`
    : '';
  const domesticLabel = r58 && snapshot.orderUnitsRange && snapshot.orderUnitsRange[1] > 100
    ? `1688到深含运（${escape(rangeText(snapshot.orderUnitsRange))}套）`
    : '1688百套含运';
  const hasSamplePending = Array.isArray(snapshot.sampleCheckItems) && snapshot.sampleCheckItems.length > 0;
  const scoreMain = snapshot.totalRange
    ? `${escape(rangeText(snapshot.totalRange))} / 100`
    : (hasSamplePending
        ? `已得分 ${escape(rangeText(snapshot.supportedRange))} / 已覆盖总权重 ${escape(numberText(snapshot.coveredWeight))}`
        : queueLabel);
  return `<div class="hero-stat">
    <p class="hero-stat-val ${marginCls}">${pctRangeText(snapshot.margins)}</p>
    <p class="hero-stat-sub">${deltaHtml}</p>
  </div>
  <dl class="side-ledger">
    <div><dt>美站参照价</dt><dd>${usdRangeText(snapshot.prices)}</dd></div>
    <div><dt>${domesticLabel}</dt><dd>${domesticMain}${domesticSub}</dd></div>
    <div><dt>扣15%广告毛利</dt><dd>${pctRangeText(snapshot.adMargins)}</dd></div>
    <div><dt>广告前单件贡献</dt><dd>${usdRangeText(snapshot.contributions)}</dd></div>
    <div><dt>21项综合评分</dt><dd><strong>${escape(scoreMain)}</strong></dd></div>
    <div><dt>已支持 ／ 权重</dt><dd class="muted">${escape(rangeText(snapshot.supportedRange))} 分 ／ ${escape(numberText(snapshot.coveredWeight))}</dd></div>
  </dl>`;
}

function r57SeasonalCard(result, original, index, rev = result?.profile_revision ?? 0) {
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const image = imageUri(presentation.image_data_uri);
  const displays = array(presentation.operating_periods);
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  const periods = array(result.operating_periods);
  const eligible = isCandidateEligible(result, rev);
  const snapshot = extractMetricsSnapshot(result, rev);
  const defaultPeriodIdx = rev >= 58
    ? Math.max(0, result.qualification?.display_period_id
      ? periods.findIndex(p => p?.id === result.qualification.display_period_id)
      : 0)
    : Math.max(0, periods.findIndex(p => p?.queue === 'comparable'));

  const supplyTabIdx = periods.length + 1;
  const bibTabIdx = periods.length + 2;
  const idxPad = String(index + 1).padStart(2, '0');
  const hasBrief = array(presentation.risks).length || array(presentation.next_checks).length || blockers.length;
  const bucketAttr = rev >= 58 ? ` data-bucket="${candidateFilterBucket(result, rev)}"` : '';

  return `<article class="candidate" id="${prefix}" data-queue="seasonal_review" data-eligible="${eligible ? 'true' : 'false'}"${bucketAttr}>
    <div class="inspector-split">
      <div class="inspector-rail">
        ${image ? `<figure class="media-frame"><img src="${escape(image)}" alt="${escape(string(presentation.image_alt, string(result.form, '候选产品参考图')))}" width="248" height="248" loading="lazy" decoding="async"><figcaption>${escape(string(presentation.image_caption, '所附参考图，供核对具体规格'))}</figcaption></figure>` : ''}
        ${renderLeftSpecLedger(snapshot, '待补证', rev)}
      </div>
      <div class="inspector-main">
        <div class="title-line">
          <span class="mono-idx">${idxPad}</span>
          <h2>${escape(result.label ?? result.candidate_id)}</h2>
          ${renderDotStatus(result, snapshot, rev)}
          <span class="muted queue-tag">分季评估</span>
        </div>
        ${typeof presentation.summary === 'string' ? `<p class="lead-copy">${escape(presentation.summary)}</p>` : ''}
        <p class="spec-copy">${escape(result.form ?? '具体可售规格尚待明确')}</p>
        ${starReferenceSection(original)}
        ${hasBrief ? `<section class="quiet-surface brief-grid" aria-label="关键风险与核查清单">
          ${r57BriefList('风险与边界提示', presentation.risks)}
          ${r57BriefList('后续核查事项', presentation.next_checks)}
          ${blockers.length ? `<div class="brief-col"><h3>共同问题与后续处理</h3><ul class="brief-list">${blockers.map(row => `<li><strong>${escape(row.problem)}</strong>${typeof row.next_step === 'string' ? `<p class="muted">下一步：${escape(row.next_step)}</p>` : ''}</li>`).join('')}</ul></div>` : ''}
        </section>` : ''}${r57ReviewNotes(result, original, rev)}${r57OperationalDisclosures(result, rev)}
        <div class="card-tabs">
          <div class="segmented-track" role="radiogroup" aria-label="${escape(result.label ?? result.candidate_id)} 视图切换">
            ${periods.map((p, idx) => {
              const pDot = p.queue === 'comparable' ? 'pass' : p.queue === 'excluded' ? 'fail' : 'pending';
              return `<label class="seg-btn" for="${prefix}-t${idx + 1}"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t${idx + 1}" ${idx === defaultPeriodIdx ? 'checked' : ''}><i class="dot dot-${pDot}" aria-hidden="true"></i>${escape(p.label)}</label>`;
            }).join('')}
            <label class="seg-btn" for="${prefix}-t${supplyTabIdx}"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t${supplyTabIdx}">1688 货源与线索</label>
            <label class="seg-btn" for="${prefix}-t${bibTabIdx}"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t${bibTabIdx}">证据回执 · ${registry.length}</label>
          </div>
          <div class="tab-panels">
            ${periods.map((period, idx) => r57PeriodPanel(period, object(displays.find(display => display?.id === period.id)), registry, prefix, idx + 1, rev)).join('')}
            <section class="tab-panel tab-p${supplyTabIdx} tab-panel-supply">${r57ContactSheetFigure(presentation, result.label ?? result.candidate_id, rev)}
              ${r57KeyValueSection('采购参考与 1688 规格核对', presentation.procurement)}
              ${r57KeyValueSection('款式事实与共同依据', presentation.facts)}
              ${r57KeyValueSection('市场范围与补充观察', presentation.market_references)}
              ${r57DiscoveryDetails(original?.discovery, registry, prefix, rev)}
            </section>
            <section class="tab-panel tab-p${bibTabIdx} tab-panel-bib">
              <div class="section-head"><h3>来源与适用限制</h3><span class="muted">本地路径已统一脱敏</span></div>
              ${r57Bibliography(registry, prefix)}
            </section>
          </div>
        </div>
      </div>
    </div>
  </article>`;
}

function r57SingleCard(result, original, index, rev = result?.profile_revision ?? 0) {
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const image = imageUri(presentation.image_data_uri);
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  const gaps = array(result.items).filter(item => item.status === 'needs_evidence');
  const mainGaps = blockers.length ? blockers : gaps.slice(0, 3).map(item => ({ problem: `${ITEM_LABELS[item.id] ?? item.id}：${reasonText(item.reason)}`, next_step: '补齐对应来源和适用口径后重新计算。' }));
  const screenGaps = array(result.screening?.conditions).filter(condition => condition.status !== 'pass');
  const queue = Object.hasOwn(QUEUES, result.queue) ? result.queue : 'pending';
  const isCrossingR59 = rev >= 59 && result?.diagnostics?.economics?.crossing_margin_floor === true;
  const complete = Array.isArray(result.total_range) && (queue === 'comparable' || isCrossingR59);
  const incompleteLabel = queue === 'excluded' ? '当前规格已排除，不列完整总分' : queue === 'deferred' ? '本期暂缓，不列完整总分' : '完整总分待补证';
  const ineligible = array(result.items).filter(item => item.status === 'ineligible');
  const coverageText = ineligible.length
    ? `已计分权重 ${numberText(result.covered_weight)} / 100；不满足合格评分条件 ${ineligible.length} 项；待补证 ${gaps.length} 项。`
    : `证据覆盖权重 ${numberText(result.covered_weight)} / 100；未评分权重 ${numberText(result.unscored_weight)}。`;
  const eligible = isCandidateEligible(result, rev);
  const snapshot = extractMetricsSnapshot(result, rev);
  const idxPad = String(index + 1).padStart(2, '0');
  const hasBrief = array(presentation.risks).length || array(presentation.next_checks).length || mainGaps.length;
  const qualReasonNote = rev >= 58 && !eligible && queue === 'pending' && array(result.qualification?.reasons).length
    ? `<p class="muted coverage-line">达标口径核验：${result.qualification.reasons.map(r => escape(sanitizeTextPaths(reasonText(r)))).join('；')}</p>`
    : '';
  const bucketAttr = rev >= 58 ? ` data-bucket="${candidateFilterBucket(result, rev)}"` : '';

  return `<article class="candidate" id="${prefix}" data-queue="${queue}" data-eligible="${eligible ? 'true' : 'false'}"${bucketAttr}>
    <div class="inspector-split">
      <div class="inspector-rail">
        ${image ? `<figure class="media-frame"><img src="${escape(image)}" alt="${escape(string(presentation.image_alt, string(result.form, '候选产品参考图')))}" width="248" height="248" loading="lazy" decoding="async"><figcaption>${escape(string(presentation.image_caption, '所附参考图，供核对具体规格'))}</figcaption></figure>` : ''}
        ${renderLeftSpecLedger(snapshot, incompleteLabel, rev)}
      </div>
      <div class="inspector-main">
        <div class="title-line">
          <span class="mono-idx">${idxPad}</span>
          <h2>${escape(result.label ?? result.candidate_id)}</h2>
          ${renderDotStatus(result, snapshot, rev)}
          <span class="muted queue-tag">${QUEUES[queue]}</span>
        </div>
        ${typeof presentation.summary === 'string' ? `<p class="lead-copy">${escape(presentation.summary)}</p>` : ''}
        <p class="spec-copy">${escape(result.form ?? '具体可售规格尚待明确')}</p>
        ${starReferenceSection(original)}
        <div class="inline-score-status">
          ${complete ? `<p>完整总分 <strong>${escape(rangeText(result.total_range))} / 100</strong></p>` : `<p class="ink-muted"><strong>${escape(incompleteLabel)}</strong></p>`}
          <p class="muted">已支持分数 ${escape(rangeText(result.supported_range))}；${escape(coverageText)}</p>
          ${result.conditional_total_range ? `<p class="muted">满足准入后可能范围 ${escape(rangeText(result.conditional_total_range))}。这是数学界限，不是已获得总分或预测。</p>` : ''}
          ${result.may_exceed_comparable_leader ? '<p class="ink-pass">有效可能上界高于当前完整队列首项的保守端点，值得补证；这不代表已经胜出。</p>' : ''}
        </div>
        ${hasBrief ? `<section class="quiet-surface brief-grid" aria-label="关键风险与缺口">
          ${r57BriefList('风险与边界提示', presentation.risks)}
          ${r57BriefList('后续核查事项', presentation.next_checks)}
          ${mainGaps.length ? `<div class="brief-col"><h3>${queue === 'excluded' && gaps.length === 0 ? '排除原因与后续处理' : '需要解决的缺口'}</h3><ul class="brief-list">${mainGaps.map(row => `<li><strong>${escape(row.problem)}</strong>${typeof row.next_step === 'string' ? `<p class="muted">下一步：${escape(row.next_step)}</p>` : ''}</li>`).join('')}</ul></div>` : ''}
        </section>` : ''}${r57ReviewNotes(result, original, rev)}${r57OperationalDisclosures(result, rev)}
        ${screenGaps.length ? `<p class="muted coverage-line">筛选状态：${screenGaps.map(condition => `${escape({ reference_price: '参考售价', margin: '毛利条件', specific_form_rights: '具体款式权利', strong_date_dependency: '日期依赖' }[condition.id] ?? condition.id)}${escape(STATES[condition.status] ?? condition.status)}：${escape(reasonText(condition.reason))}`).join('；')}</p>` : '<p class="muted coverage-line">初筛条件已得到有据判断；这不是采购批准或供应验证。</p>'}${qualReasonNote}
        <div class="card-tabs">
          <div class="segmented-track" role="radiogroup" aria-label="${escape(result.label ?? result.candidate_id)} 视图切换">
            <label class="seg-btn" for="${prefix}-t1"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t1" checked>费用拆解与 21 项评分</label>
            <label class="seg-btn" for="${prefix}-t2"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t2">采购核对与线索</label>
            <label class="seg-btn" for="${prefix}-t3"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t3">证据回执 · ${registry.length}</label>
          </div>
          <div class="tab-panels">
            <section class="tab-panel tab-p1">
              ${r57EconomicWaterfall(result, `${prefix}-econ-main`, rev)}
              <section class="ledger-section">
                <div class="section-head"><h3>21 项评分明细</h3><span class="muted">8 大维度 · 点击编号直达原始证据</span></div>
                ${r57ScoreRows(result, registry, prefix, rev)}
              </section>
              ${r57NewcomerDetails(result, rev)}
            </section>
            <section class="tab-panel tab-p2 tab-panel-supply">${r57ContactSheetFigure(presentation, result.label ?? result.candidate_id, rev)}
              ${r57KeyValueSection('采购参考与规格核对', presentation.procurement)}
              ${r57KeyValueSection('市场范围与新增观察', presentation.market_references)}
              ${r57DiscoveryDetails(original?.discovery, registry, prefix, rev)}
            </section>
            <section class="tab-panel tab-p3 tab-panel-bib">
              <div class="section-head"><h3>来源与适用限制</h3><span class="muted">本地路径已统一脱敏</span></div>
              ${r57Bibliography(registry, prefix)}
            </section>
          </div>
        </div>
      </div>
    </div>
  </article>`;
}

function renderComparisonMatrix(candidates, originals, rev = 57) {
  if (!candidates.length) return '';
  const snaps = candidates.map(cand => extractMetricsSnapshot(cand, rev));
  const anyOver100 = rev >= 58 && snaps.some(s => s.orderUnitsRange && s.orderUnitsRange[1] > 100);
  const domesticColHeader = anyOver100 ? '1688到深含运' : '1688百套含运';
  return `<section id="overview" class="matrix-block" aria-labelledby="matrix-heading">
    <div class="section-head">
      <h2 id="matrix-heading">横向对比总览</h2>
      <span class="muted">点击款式直达详情核账</span>
    </div>
    <div tabindex="0" role="region" aria-labelledby="matrix-heading" class="table-scroll">
      <table class="hairline-table matrix-table">
        <thead>
          <tr>
            <th scope="col">候选款式</th>
            <th scope="col">结论</th>
            <th scope="col" class="num-col">美站参照价</th>
            <th scope="col" class="num-col">${domesticColHeader}</th>
            <th scope="col" class="num-col">广告前毛利</th>
            <th scope="col" class="num-col">扣15%广告后</th>
            <th scope="col" class="num-col">单件贡献</th>
            <th scope="col" class="num-col">21项总分</th>
            <th scope="col">采购前头号核查</th>
          </tr>
        </thead>
        <tbody>
          ${candidates.map((cand, idx) => {
            const orig = originals.get(cand?.candidate_id);
            const pres = object(orig?.presentation);
            const snap = snaps[idx];
            const eligible = isCandidateEligible(cand, rev);
            const bucketAttr = rev >= 58 ? ` data-bucket="${candidateFilterBucket(cand, rev)}"` : '';
            const topCheck = array(pres.next_checks)[0] ?? array(pres.risks)[0] ?? array(pres.blockers)[0]?.problem ?? '核对下方评分明细';
            const topCheckStr = typeof topCheck === 'string' ? topCheck : string(topCheck?.label || topCheck?.problem, '核对下方评分明细');
            const leadMatch = topCheckStr.match(/^([^：:—]{4,26})[：:—]\s*(.*)$/s);
            let clipped = topCheckStr;
            if (leadMatch) {
              const head = leadMatch[1].trim();
              const firstClause = leadMatch[2].split(/[，；。]/)[0].trim();
              clipped = head.length >= 6 ? head : `${head} · ${firstClause.length > 26 ? `${firstClause.slice(0, 25).replace(/[0-9a-zA-Z.%+$]+$/, '').trim()}…` : firstClause}`;
            } else if (topCheckStr.length > 28) {
              clipped = `${topCheckStr.slice(0, 27).replace(/[0-9a-zA-Z.%+$]+$/, '').trim()}…`;
            }
            const mCls = rev >= 58
              ? (snap.marginFloorStatus === 'pass' ? 'ink-pass' : snap.marginFloorStatus === 'fail' ? 'ink-fail' : snap.marginFloorStatus === 'cross' ? '' : 'ink-muted')
              : (snap.margins ? (snap.margins[0] >= 0.3 ? 'ink-pass' : snap.margins[1] < 0.3 ? 'ink-fail' : '') : 'ink-muted');
            const unitsSuffix = anyOver100 && snap.orderUnitsRange && snap.orderUnitsRange[1] > 100
              ? `（${escape(rangeText(snap.orderUnitsRange))}套）` : '';
            return `<tr data-eligible="${eligible ? 'true' : 'false'}"${bucketAttr}>
              <th scope="row"><a class="row-jump" href="#candidate-${idx + 1}"><span class="mono-idx">${String(idx + 1).padStart(2, '0')}</span>${escape(cand.label ?? cand.candidate_id)}</a></th>
              <td>${renderDotStatus(cand, snap, rev)}</td>
              <td class="num-col">${usdRangeText(snap.prices)}</td>
              <td class="num-col">${snap.cnyTotals ? `${escape(rangeText(snap.cnyTotals))} 元` : usdRangeText(snap.domesticDelivered)}${unitsSuffix}</td>
              <td class="num-col ${mCls}"><strong>${pctRangeText(snap.margins)}</strong></td>
              <td class="num-col">${pctRangeText(snap.adMargins)}</td>
              <td class="num-col">${usdRangeText(snap.contributions)}</td>
              <td class="num-col"><strong>${snap.totalRange ? `${escape(rangeText(snap.totalRange))}` : `已得 ${escape(rangeText(snap.supportedRange))}`}</strong></td>
              <td class="matrix-check">${escape(clipped)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </section>`;
}

function r57BatchContext(presentation) {
  const linkedSummary = r57DiscoverySummary(presentation.discovery_summary);
  const discovery = array(presentation.discovery);
  const timings = array(presentation.timings);
  const limitations = array(presentation.limitations);
  if (!discovery.length && !timings.length && !limitations.length) return linkedSummary ? `<div class="footer-meta">${linkedSummary}</div>` : '';
  return `<section class="method-section" aria-labelledby="method-heading"><h2 id="method-heading" class="sr-only">核算边界与发现路径</h2><details class="quiet-fold batch-context"><summary>核算边界、发现路径与耗时记录</summary><div class="fold-body">${linkedSummary}${limitations.length ? `<h3>核算与方法边界</h3><ul>${limitations.map(value => `<li>${escape(readable(value))}</li>`).join('')}</ul>` : ''}${discovery.length ? `<h3>发现与覆盖记录</h3><ul>${discovery.map(value => {
    if (typeof value === 'string') return `<li>${escape(value)}</li>`;
    const row = object(value);
    return `<li><strong>${escape(string(row.label, '发现记录'))}</strong>${typeof row.detail === 'string' ? `：${escape(row.detail)}` : ''}${typeof row.status === 'string' ? `（${escape(row.status)}）` : ''}${row.source || safeHttpUrl(row.url) ? `<p class="source">${sourceLink(string(row.source, '查看来源'), row.url)}${typeof row.observed_at === 'string' ? ` · ${escape(row.observed_at)}` : ''}</p>` : ''}</li>`;
  }).join('')}</ul>` : ''}${timings.length ? `<h3>记录耗时</h3><dl class="kv-rows">${timings.map(value => {
    const row = object(value);
    return `<div class="kv-row"><dt>${escape(string(row.label, '阶段'))}</dt><dd>${finite(row.seconds) && row.seconds >= 0 ? `${escape(numberText(row.seconds))} 秒` : '未测量'}${typeof row.note === 'string' ? `<p class="muted">${escape(row.note)}</p>` : ''}</dd></div>`;
  }).join('')}</dl>` : ''}</div></details></section>`;
}

const R57_CSS = `
:root{
  color-scheme:light;
  --canvas:oklch(100% 0 0);
  --quiet:oklch(0% 0 0 / .026);
  --frame:oklch(96.8% 0 0);
  --pill-bg:oklch(0% 0 0 / .058);
  --pill-hover:oklch(0% 0 0 / .092);
  --ink:oklch(14% 0 0);
  --ink-2:oklch(28% 0 0);
  --muted:oklch(0% 0 0 / .56);
  --hairline:oklch(0% 0 0 / .075);
  --hairline-strong:oklch(0% 0 0 / .14);
  --dot-pass:oklch(60% .17 150);
  --dot-warn:oklch(68% .15 75);
  --dot-fail:oklch(57% .21 25);
  --ink-pass:#0b613d;
  --ink-fail:#a61b29;
}
*{box-sizing:border-box}
html{
  font-size:16px;
  scroll-behavior:smooth;
  scroll-padding-top:76px;
  scrollbar-width:thin;
  scrollbar-color:oklch(0% 0 0 / .22) transparent;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{
  margin:0;
  background:var(--canvas);
  color:var(--ink);
  font:400 .875rem/1.6 "Inter","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI",ui-sans-serif,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;
  overflow-wrap:anywhere;
}
::selection{background:#0000001c;color:var(--ink)}
a{color:var(--ink);text-underline-offset:.24em;text-decoration-color:var(--hairline-strong);text-decoration-thickness:1px}
a:hover{text-decoration-color:var(--ink)}
a:focus-visible,summary:focus-visible,.table-scroll:focus-visible,.pill-btn:has(:focus-visible),.seg-btn:has(:focus-visible),.ring-btn:has(:focus-visible){
  outline:2px solid var(--ink);
  outline-offset:2px;
  border-radius:7px;
}
.ico{display:inline-block;vertical-align:-.12em;flex-shrink:0}
.sep-bar{display:inline-block;width:1px;height:10px;background:var(--hairline-strong);margin-inline:7px;vertical-align:-1px}
h1,h2,h3,h4,p,figure,dl,dd{margin:0}
h1{font-size:1.375rem;font-weight:600;line-height:1.32}
h2{font-size:1.25rem;font-weight:600;line-height:1.34}
h3{font-size:.9375rem;font-weight:600;line-height:1.42}
h4{font-size:.875rem;font-weight:500;line-height:1.45}
code,.mono-id,.mono-idx,.mono-kw{
  font-family:"Departure Mono","JetBrains Mono",ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;
  font-size:.8125rem;
}
.mono-id{color:var(--muted)}
.mono-idx{color:var(--muted);font-size:.8125rem;margin-right:6px}
.mono-kw{color:var(--ink);font-weight:500}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip-link{position:absolute;top:-100px;left:16px;background:var(--ink);color:#fff;padding:8px 14px;border-radius:9999px;z-index:60;text-decoration:none;font-size:.8125rem}
.skip-link:focus{top:12px}

.shell{
  max-width:1640px;
  margin-inline:auto;
  padding:20px 24px 72px;
  display:grid;
  grid-template-columns:216px minmax(0,1fr);
  gap:40px;
  align-items:start;
}
@media(min-width:1712px){
  .shell{border-inline:1px solid var(--hairline)}
}

.side-rail{
  position:sticky;
  top:20px;
  display:flex;
  flex-direction:column;
  gap:28px;
  padding-right:16px;
}
.rail-brand{
  display:flex;
  align-items:center;
  gap:9px;
  font-weight:600;
  font-size:.875rem;
  color:var(--ink);
}
.brand-mark{
  width:18px;
  height:18px;
  border-radius:4px;
  background:var(--ink);
  display:inline-block;
  flex-shrink:0;
}
.rail-group{display:flex;flex-direction:column;gap:4px}
.rail-heading{
  font-size:.8125rem;
  font-weight:500;
  color:var(--muted);
  margin-bottom:4px;
}
.rail-link{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  min-height:28px;
  padding:3px 8px;
  margin-inline:-8px;
  border-radius:6px;
  text-decoration:none;
  color:var(--ink-2);
  font-size:.8125rem;
  line-height:1.35;
}
.rail-link:hover{background:var(--frame);color:var(--ink)}
.rail-link-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rail-specs{display:flex;flex-direction:column;gap:6px;font-size:.8125rem}
.rail-specs div{display:flex;justify-content:space-between;gap:8px}
.rail-specs dt{color:var(--muted)}
.rail-specs dd{color:var(--ink-2);font-weight:500}
.rail-foot{font-size:.8125rem;color:var(--muted);padding-top:14px;border-top:1px solid var(--hairline)}

.workspace{min-width:0}

.banner-line{
  display:flex;
  flex-direction:column;
  gap:6px;
  padding-bottom:6px;
}
.banner-sub{color:var(--ink-2);font-size:.875rem;line-height:1.58;max-width:74ch}
.batch-counts{color:var(--muted);font-size:.8125rem;max-width:82ch}

.filter-radio,.tab-radio,.mode-check{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}

.sticky-bar{
  position:sticky;
  top:0;
  z-index:20;
  background:var(--canvas);
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:10px 16px;
  padding:12px 14px;
  margin-inline:-14px;
  border-bottom:1px solid var(--hairline);
}
.pill-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pill-btn{
  position:relative;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  gap:6px;
  height:28px;
  padding-inline:12px;
  border-radius:9999px;
  background:var(--pill-bg);
  color:var(--muted);
  font-size:.8125rem;
  font-weight:500;
  line-height:1;
  user-select:none;
  transition:background-color .14s ease,color .14s ease,transform .12s cubic-bezier(.2,0,0,1);
}
.pill-btn:hover{background:var(--pill-hover);color:var(--ink)}
@media(prefers-reduced-motion:no-preference){
  .pill-btn:active,.seg-btn:active,.ring-btn:active,.pill-link:active{transform:scale(.97)}
}
.ring-btn{
  position:relative;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  gap:6px;
  height:28px;
  padding-inline:12px;
  border-radius:9999px;
  background:var(--canvas);
  color:var(--ink-2);
  font-size:.8125rem;
  font-weight:500;
  box-shadow:0 0 0 .5px oklch(0% 0 0 / .11),0 1px 2px oklch(0% 0 0 / .06);
  user-select:none;
  transition:background-color .14s ease,color .14s ease,transform .12s cubic-bezier(.2,0,0,1);
}
.ring-btn:hover{background:var(--frame);color:var(--ink)}

.pill-btn:has(:checked),
.ring-btn:has(:checked){
  background:var(--ink);
  color:#fff;
  box-shadow:none;
}
.item-qualifier{display:none}
.workspace:has(#expand-qualifiers:checked) .item-qualifier{display:block}

.workspace:has(#filter-pass:checked) .candidate[data-eligible="false"],
.workspace:has(#filter-pass:checked) .matrix-table tbody tr[data-eligible="false"],
.workspace:has(#filter-hold:checked) .candidate[data-eligible="true"],
.workspace:has(#filter-hold:checked) .matrix-table tbody tr[data-eligible="true"]{
  display:none;
}
.filter-empty{display:none;padding:28px 0;border-bottom:1px solid var(--hairline);font-size:.875rem}
.workspace:has(#filter-pass:checked):not(:has(.candidate[data-eligible="true"])) .filter-empty,
.workspace:has(#filter-hold:checked):not(:has(.candidate[data-eligible="false"])) .filter-empty{display:block}
.workspace:has(#filter-pass:checked):not(:has(.candidate[data-eligible="true"])) .matrix-block,
.workspace:has(#filter-hold:checked):not(:has(.candidate[data-eligible="false"])) .matrix-block{display:none}

.bar-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.queue-nav{display:flex;gap:10px;font-size:.8125rem}
.queue-nav a{color:var(--ink-2);text-decoration:underline;text-decoration-color:var(--hairline-strong);text-underline-offset:.24em}
.queue-nav a:hover{color:var(--ink);text-decoration-color:var(--ink)}

.dot{
  width:6px;
  height:6px;
  border-radius:9999px;
  display:inline-block;
  flex-shrink:0;
  background:var(--muted);
}
.state-pass .dot,.dot-pass{background:var(--dot-pass)}
.state-pending .dot,.dot-pending,.dot-warn{background:var(--dot-warn)}
.state-fail .dot,.dot-fail{background:var(--dot-fail)}
.state-inline{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:.8125rem;
  font-weight:500;
  color:var(--ink);
  white-space:nowrap;
}
.ink-pass{color:var(--ink-pass)}
.ink-fail{color:var(--ink-fail)}
.ink-muted,.muted{color:var(--muted)}

.matrix-block{margin-top:24px}
.section-head{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:6px 16px;
  margin-bottom:10px;
}
.table-scroll{
  overflow:auto;
  max-inline-size:100%;
  container-type:inline-size;
  scrollbar-width:thin;
  scrollbar-color:oklch(0% 0 0 / .22) transparent;
}
.hairline-table{
  width:100%;
  border-collapse:collapse;
  font-size:.8125rem;
}
.hairline-table th,.hairline-table td{
  padding:10px 12px;
  text-align:left;
  border-bottom:1px solid var(--hairline);
  border-right:1px solid oklch(0% 0 0 / .048);
  vertical-align:middle;
}
.hairline-table th:first-child,.hairline-table td:first-child{padding-left:0}
.hairline-table th:last-child,.hairline-table td:last-child{padding-right:0;border-right:0}
.hairline-table thead th{
  color:var(--muted);
  font-weight:500;
  border-bottom:1px solid var(--hairline-strong);
  white-space:nowrap;
}
.hairline-table .num-col{text-align:right;white-space:nowrap}
.hairline-table tbody th{font-weight:500;color:var(--ink)}
.hairline-table tbody tr:hover th,.hairline-table tbody tr:hover td{background:var(--quiet)}
.th-note{display:block;font-size:.8125rem;font-weight:400;color:var(--muted)}
.row-jump{text-decoration:underline;text-decoration-color:var(--hairline-strong);text-underline-offset:.24em;font-weight:500;color:var(--ink)}
.row-jump:hover{text-decoration-color:var(--ink)}
.matrix-check{color:var(--ink-2);max-width:28ch}

.candidate{
  margin-top:48px;
  padding-top:36px;
  border-top:1px solid var(--hairline-strong);
  scroll-margin-top:72px;
}
.inspector-split{
  display:grid;
  grid-template-columns:248px minmax(0,1fr);
  gap:36px;
  align-items:start;
}
.inspector-rail{display:flex;flex-direction:column;gap:18px}
@media(min-width:721px){
  .inspector-rail{position:sticky;top:72px}
}
.media-frame{margin:0}
.media-frame img{
  display:block;
  width:100%;
  height:auto;
  aspect-ratio:1/1;
  object-fit:contain;
  background:var(--frame);
  border-radius:8px;
  padding:10px;
  box-shadow:inset 0 0 0 1px oklch(0% 0 0 / .055);
}
.media-frame figcaption{
  margin-top:8px;
  font-size:.8125rem;
  line-height:1.45;
  color:var(--muted);
}

.hero-stat{padding-top:2px}
.hero-stat-val{font-size:1.5rem;font-weight:600;line-height:1.18}
.hero-stat-sub{margin-top:4px;font-size:.8125rem;line-height:1.4}

.side-ledger{
  display:flex;
  flex-direction:column;
  border-top:1px solid var(--hairline);
}
.side-ledger>div{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:12px;
  padding:8px 0;
  border-bottom:1px solid var(--hairline);
  font-size:.8125rem;
}
.side-ledger dt{color:var(--muted);flex-shrink:0}
.side-ledger dd{text-align:right;color:var(--ink)}

.inspector-main{min-width:0}
.title-line{
  display:flex;
  align-items:baseline;
  flex-wrap:wrap;
  gap:8px 12px;
}
.title-line h2{flex:1;min-width:min(240px,100%)}
.queue-tag{font-size:.8125rem}
.lead-copy{
  margin-top:10px;
  font-size:.9375rem;
  line-height:1.62;
  color:var(--ink);
  max-width:70ch;
}
.spec-copy{
  margin-top:6px;
  font-size:.8125rem;
  line-height:1.55;
  color:var(--muted);
  max-width:72ch;
}
.star-ref{margin-top:6px;font-size:.8125rem;color:var(--muted)}
.inline-score-status{
  margin-top:12px;
  padding-block:10px;
  border-block:1px solid var(--hairline);
  font-size:.8125rem;
}

.quiet-surface{
  margin-top:18px;
  background:var(--quiet);
  border-radius:8px;
  padding:16px 20px;
}
.brief-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
  gap:18px 28px;
}
.brief-col h3{margin-bottom:8px;color:var(--ink)}
.brief-list{padding-inline-start:1.15em;margin:0;font-size:.8125rem;line-height:1.58;color:var(--ink-2)}
.brief-list li+li{margin-top:6px}

.card-tabs{margin-top:24px}
.segmented-track{
  display:inline-flex;
  align-items:center;
  flex-wrap:wrap;
  gap:2px;
  padding:3px;
  border-radius:10px;
  background:oklch(0% 0 0 / .052);
}
.seg-btn{
  position:relative;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  gap:6px;
  height:28px;
  padding-inline:12px;
  border-radius:7px;
  color:var(--muted);
  font-size:.8125rem;
  font-weight:500;
  line-height:1;
  user-select:none;
  transition:background-color .14s ease,color .14s ease,box-shadow .14s ease,transform .12s cubic-bezier(.2,0,0,1);
}
.seg-btn:hover{color:var(--ink)}
.tab-panel{display:none;padding-top:20px}
.seg-btn:has(:checked){
  background:var(--canvas);
  color:var(--ink);
  box-shadow:0 1px 2px oklch(0% 0 0 / .08),0 0 0 .5px oklch(0% 0 0 / .08);
}
.card-tabs:has(input[id$="-t1"]:checked) .tab-p1,
.card-tabs:has(input[id$="-t2"]:checked) .tab-p2,
.card-tabs:has(input[id$="-t3"]:checked) .tab-p3,
.card-tabs:has(input[id$="-t4"]:checked) .tab-p4,
.card-tabs:has(input[id$="-t5"]:checked) .tab-p5{
  display:block;
}
.card-tabs:has(.tab-panel-bib :target) .tab-panel-bib{
  display:block;
  margin-top:20px;
  padding-top:20px;
  border-top:1px solid var(--hairline-strong);
}
@supports not selector(:has(*)){
  .tab-panel{display:block;margin-top:20px}
}

.period-meta-line{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:10px 24px;
  padding-bottom:12px;
  border-bottom:1px solid var(--hairline);
}
.period-note{margin-top:4px;font-size:.8125rem;color:var(--ink-2);max-width:68ch}
.period-inline-nums{display:flex;gap:16px;flex-wrap:wrap;font-size:.8125rem;color:var(--ink-2)}
.period-inline-nums strong{color:var(--ink)}
.coverage-line{margin-top:8px;font-size:.8125rem}

.ledger-section{margin-top:26px}
.ledger-section>h3{margin-bottom:10px}
.section-lead{margin-bottom:6px;max-width:72ch}
.alloc-strip{margin:8px 0 16px;padding:12px 14px;background:var(--quiet);border-radius:8px}
.alloc-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px 16px;font-size:.8125rem;margin-bottom:8px}
.alloc-track{position:relative;display:flex;height:8px;border-radius:9999px;background:oklch(0% 0 0 / .06);overflow:hidden}
.alloc-seg{height:100%;display:block}
.alloc-supply{background:oklch(22% 0 0)}
.alloc-platform{background:oklch(68% 0 0)}
.alloc-margin-pass{background:var(--dot-pass)}
.alloc-margin-fail{background:var(--dot-fail)}
.alloc-tick{position:absolute;top:0;bottom:0;left:70%;width:1.5px;background:var(--canvas);box-shadow:0 0 0 .75px var(--ink)}
.alloc-legend{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:9px;font-size:.8125rem;color:var(--ink-2)}
.alloc-legend span{display:inline-flex;align-items:center;gap:6px}
.swatch{width:7px;height:7px;border-radius:2px;display:inline-block;flex-shrink:0}
.swatch-supply{background:oklch(22% 0 0)}
.swatch-platform{background:oklch(68% 0 0)}
.swatch-pass{background:var(--dot-pass)}
.swatch-fail{background:var(--dot-fail)}
.waterfall-table thead th:first-child{position:sticky;inset-inline-start:0;background:var(--canvas);z-index:2}
.waterfall-table tbody th{position:sticky;inset-inline-start:0;background:var(--canvas);z-index:1}
.waterfall-table tbody tr:hover th{background:#f8f8f8}
.waterfall-table .row-dim th,.waterfall-table .row-dim td{color:var(--muted)}
.waterfall-table .row-sum th,.waterfall-table .row-sum td{border-top:1px solid var(--hairline-strong)}

.scenario-folds{margin-top:8px}
.quiet-fold{border-bottom:1px solid var(--hairline)}
summary{
  list-style:none;
  cursor:pointer;
  display:flex;
  align-items:center;
  gap:8px;
  min-height:36px;
  padding:8px 0;
  font-size:.8125rem;
  font-weight:500;
  color:var(--ink-2);
}
summary::-webkit-details-marker{display:none}
summary::before{
  content:"";
  width:5px;
  height:5px;
  border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor;
  transform:rotate(-45deg);
  flex-shrink:0;
}
details[open]>summary::before{transform:rotate(45deg)}
@media(prefers-reduced-motion:no-preference){
  summary::before{transition:transform .16s ease}
  details::details-content{
    interpolate-size:allow-keywords;
    overflow:clip;
    contain:layout;
    transition:block-size .2s ease,content-visibility .2s ease;
    transition-behavior:allow-discrete;
  }
  details:not([open])::details-content{block-size:0}
}
summary:hover{color:var(--ink)}
.fold-body{padding:4px 0 14px 14px;font-size:.8125rem;color:var(--ink-2)}
.fold-body h3{margin:12px 0 6px}
.fold-body ul{padding-inline-start:1.2em;margin:6px 0}
.fold-body li+li{margin-top:5px}

.score-columns{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(340px,1fr));
  gap:24px 36px;
}
.score-group{border-top:1px solid var(--hairline-strong);padding-top:10px}
.group-bar{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:12px;
  padding-bottom:8px;
  border-bottom:1px solid var(--hairline);
}
.group-pts{font-size:.8125rem;font-weight:500}
.item-row{padding:11px 0;border-bottom:1px solid var(--hairline);font-size:.8125rem}
.item-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:3px}
.item-score{font-weight:600;flex-shrink:0}
.item-input{color:var(--ink-2)}
.item-reason{margin-top:3px;color:var(--ink)}
.item-row>.source{margin-top:4px}
.cite-fold{border:0;margin-top:2px}
.cite-fold>summary{min-height:24px;padding:2px 0;color:var(--muted)}

.bid-block{margin-top:10px;padding-top:10px;border-top:1px solid var(--hairline)}
.bid-summary-line{margin-bottom:4px}
.bid-rows{margin-top:8px;border-top:1px solid var(--hairline)}
.bid-row{padding:10px 0}
.bid-row+.bid-row{border-top:1px solid var(--hairline)}
.bid-row-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.bid-row-meta{font-size:.8125rem}
.bid-sub{margin-top:2px}

.kv-rows{border-top:1px solid var(--hairline)}
.kv-row{
  display:grid;
  grid-template-columns:180px minmax(0,1fr);
  gap:16px;
  padding:10px 0;
  border-bottom:1px solid var(--hairline);
  font-size:.8125rem;
}
.kv-row dt{color:var(--muted);font-weight:500}
.kv-main{color:var(--ink);font-weight:500}
.pill-link{
  display:inline-flex;
  align-items:center;
  height:22px;
  padding-inline:9px;
  margin-left:6px;
  border-radius:9999px;
  background:var(--pill-bg);
  color:var(--ink);
  text-decoration:none;
  font-size:.8125rem;
  font-weight:500;
}
.pill-link:hover{background:var(--pill-hover)}

.lead-list,.bibliography{padding-inline-start:1.35em;margin:8px 0;font-size:.8125rem}
.lead-list li+li{margin-top:8px}
.bibliography li{padding:9px 6px;border-bottom:1px solid var(--hairline);scroll-margin-top:84px}
.bibliography li:target{background:var(--frame);border-radius:6px}
.bib-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px 16px;flex-wrap:wrap}
.bib-meta{color:var(--muted);font-size:.8125rem}

.source{font-size:.8125rem;line-height:1.5;color:var(--muted)}
p+p{margin-top:5px}
.method-section{margin-top:44px}
.empty-state{padding:40px 0;border-top:1px solid var(--hairline)}
.report-footer{
  margin-top:28px;
  padding-top:18px;
  border-top:1px solid var(--hairline);
  font-size:.8125rem;
  color:var(--muted);
  display:flex;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:8px 24px;
}

@container (width < 680px){
  .matrix-table,.matrix-table thead,.matrix-table tbody,.matrix-table tr,.matrix-table th,.matrix-table td{display:block}
  .matrix-table thead{display:none}
  .matrix-table tr{padding:12px 0;border-bottom:1px solid var(--hairline-strong)}
  .matrix-table tbody th{padding:0 0 6px;border-bottom:0;border-right:0}
  .matrix-table td,.matrix-table .num-col{border-bottom:0;border-right:0;padding:4px 0;display:flex;justify-content:space-between;align-items:baseline;gap:12px;text-align:right;white-space:normal}
  .matrix-table td::before{flex-shrink:0;white-space:nowrap;color:var(--muted)}
  .matrix-table td.matrix-check{flex-direction:column;align-items:flex-start;text-align:left;gap:2px;max-width:none}
  .matrix-table{
    --m2:"结论";--m3:"美站参照价";--m4:"1688百套含运";--m5:"广告前毛利";
    --m6:"扣15%广告后";--m7:"单件贡献";--m8:"21项总分";--m9:"采购前头号核查";
  }
  .matrix-table td:nth-child(2)::before{content:var(--m2)}
  .matrix-table td:nth-child(3)::before{content:var(--m3)}
  .matrix-table td:nth-child(4)::before{content:var(--m4)}
  .matrix-table td:nth-child(5)::before{content:var(--m5)}
  .matrix-table td:nth-child(6)::before{content:var(--m6)}
  .matrix-table td:nth-child(7)::before{content:var(--m7)}
  .matrix-table td:nth-child(8)::before{content:var(--m8)}
  .matrix-table td:nth-child(9)::before{content:var(--m9)}
}

@media(max-width:1024px){
  .shell{grid-template-columns:1fr;gap:20px;padding:16px 18px 56px}
  .side-rail{
    position:static;
    flex-direction:row;
    flex-wrap:wrap;
    align-items:center;
    justify-content:space-between;
    gap:12px 20px;
    padding-right:0;
    padding-bottom:12px;
    border-bottom:1px solid var(--hairline);
  }
  .rail-specs-group,.rail-foot{display:none}
  .rail-group{flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px}
  .rail-heading{flex-basis:100%;margin:0 0 2px}
  .rail-link{margin-inline:0;background:var(--pill-bg);border-radius:9999px;padding-inline:10px}
}

@media(max-width:720px){
  .inspector-split{grid-template-columns:1fr;gap:20px}
  .media-frame{display:flex;align-items:center;gap:14px}
  .media-frame img{width:104px;height:104px;flex-shrink:0}
  .media-frame figcaption{margin-top:0}
  .score-columns{grid-template-columns:1fr}
  .kv-row{grid-template-columns:1fr;gap:3px}
  .waterfall-table th:first-child{max-width:136px;white-space:normal}
  .sticky-bar{position:static}
}

@media print{
  body{background:#fff;color:#000;font-size:9.5pt}
  .shell{display:block;padding:0}
  .side-rail,.sticky-bar,.skip-link,.pill-bar,.segmented-track{display:none!important}
  .tab-panel{display:block!important;padding-top:10pt}
  details::details-content{display:block;content-visibility:visible}
  details>*{display:block!important}
  .item-qualifier{display:block!important}
  .media-frame img{width:90pt;height:90pt}
}
`;

function renderR57Report(result, batch = {}) {
  const rev = result?.profile_revision ?? 57;
  const r58 = isR58(result);
  const rawPresentation = { ...object(batch?.presentation), discovery_summary: batch?.discovery_summary };
  const presentation = r58 ? sanitizeDisplayTree(rawPresentation) : rawPresentation;
  const rawCandidates = array(result?.candidates);
  const candidates = r58 ? rawCandidates.map(c => sanitizeDisplayTree(c)) : rawCandidates;
  const originals = new Map(array(batch?.candidates).map(candidate => [
    candidate?.id,
    r58 && candidate
      ? {
        ...candidate,
        presentation: sanitizeDisplayTree(candidate.presentation, '', true),
        discovery: sanitizeDisplayTree(candidate.discovery),
        market: sanitizeDisplayTree(candidate.market),
      }
      : candidate,
  ]));
  const title = string(presentation.title, '美国站 FBA 选品决策看板');
  const counts = object(result?.summary);
  const eligibleCount = candidates.filter(cand => isCandidateEligible(cand, rev)).length;
  const holdCount = r58
    ? candidates.filter(cand => candidateFilterBucket(cand, rev) === 'hold').length
    : (candidates.length - eligibleCount);
  const pendingBucketCount = r58
    ? candidates.filter(cand => candidateFilterBucket(cand, rev) === 'pending').length
    : 0;
  const completeCount = r58
    ? candidates.filter(cand => cand?.queue === 'comparable' && isCandidateEligible(cand, rev)).length
    : counts.complete;
  const pendingCount = r58
    ? candidates.filter(cand => cand?.queue === 'pending').length
    : counts.pending;
  const seasonalReviewCount = r58
    ? candidates.filter(cand => cand?.queue === 'seasonal_review').length
    : counts.seasonal_review;
  const seasonalEligibleCount = r58
    ? candidates.filter(cand => cand?.queue === 'seasonal_review' && isCandidateEligible(cand, rev)).length
    : counts.seasonal_eligible;
  const seasonalPendingCount = r58 ? Math.max(0, seasonalReviewCount - seasonalEligibleCount) : 0;
  // r58 headline and queueLinks use the same displayed-card buckets as the filter pills; r57 keeps flat summary wording.
  const seasonalInPendingBucket = r58
    ? candidates.filter(cand => cand?.queue === 'seasonal_review' && candidateFilterBucket(cand, rev) === 'pending').length
    : 0;
  const seasonalInHoldBucket = r58
    ? candidates.filter(cand => cand?.queue === 'seasonal_review' && candidateFilterBucket(cand, rev) === 'hold').length
    : 0;
  const headlineHoldSuffix = r58 && holdCount > 0
    ? `，淘汰／暂缓 ${escape(numberText(holdCount))} 个${seasonalInHoldBucket ? `（含分季排除／暂缓 ${escape(numberText(seasonalInHoldBucket))} 个）` : ''}`
    : '';
  const headlinePendingText = r58
    ? `待补证 ${escape(numberText(pendingBucketCount))} 个${seasonalInPendingBucket ? `（含分季待补 ${escape(numberText(seasonalInPendingBucket))} 个）` : ''}${headlineHoldSuffix}`
    : `待补证 ${escape(numberText(pendingCount))} 个`;

  const seasonalCounts = seasonalReviewCount
    ? `分季评估 ${escape(numberText(seasonalReviewCount))} 个款式，其中 2027 年 2—9 月主营淡季初评达标 ${escape(numberText(seasonalEligibleCount))} 个款式（非强节日依赖且覆盖完整 2027-02-01 至 2027-09-30 淡季窗口）；各经营季节由主人选择。`
    : '';
  const r58OrderRule = r58
    ? '全年 12 个月完整可比卡优先列于 2—9 月主营淡季达标卡之前；区间重叠不代表严格优劣。'
    : '';
  const queueLinks = r58
    ? [
      (() => {
        const idx = candidates.findIndex(c => c?.queue === 'comparable' && isCandidateEligible(c, rev));
        return idx >= 0 ? `<a href="#candidate-${idx + 1}">完整可比 ${escape(numberText(completeCount))}</a>` : '';
      })(),
      (() => {
        const idx = candidates.findIndex(c => c?.queue === 'seasonal_review' && isCandidateEligible(c, rev));
        return idx >= 0 ? `<a href="#candidate-${idx + 1}">分季达标 ${escape(numberText(seasonalEligibleCount))}</a>` : '';
      })(),
      (() => {
        const idx = candidates.findIndex(c => c?.queue === 'pending');
        return idx >= 0 ? `<a href="#candidate-${idx + 1}">待补证 ${escape(numberText(pendingCount))}</a>` : '';
      })(),
      (() => {
        const idx = candidates.findIndex(c => c?.queue === 'seasonal_review' && candidateFilterBucket(c, rev) === 'pending');
        return idx >= 0 ? `<a href="#candidate-${idx + 1}">分季待补 ${escape(numberText(seasonalInPendingBucket))}</a>` : '';
      })(),
      (() => {
        const idx = candidates.findIndex(c => candidateFilterBucket(c, rev) === 'hold');
        return idx >= 0 && holdCount > 0 ? `<a href="#candidate-${idx + 1}">淘汰／暂缓 ${escape(numberText(holdCount))}</a>` : '';
      })(),
    ].join('')
    : Object.entries(QUEUES).map(([key, label]) => {
      const index = candidates.findIndex(candidate => candidate?.queue === key);
      const countVal = counts[key === 'comparable' ? 'complete' : key];
      return index >= 0 ? `<a href="#candidate-${index + 1}">${label} ${escape(numberText(countVal))}</a>` : '';
    }).join('');
  const maxPanels = r58
    ? Math.max(12, ...candidates.map(c => (c?.queue === 'seasonal_review' ? array(c.operating_periods).length + 2 : 3)))
    : 5;
  const anyOver100Report = r58 && candidates.some(cand => {
    const s = extractMetricsSnapshot(cand, rev);
    return s.orderUnitsRange && s.orderUnitsRange[1] > 100;
  });
  const r58ExtraCss = r58
    ? `\n${Array.from({ length: maxPanels - 5 }, (_, idx) => `.card-tabs:has(input[id$="-t${idx + 6}"]:checked) .tab-p${idx + 6}`).join(',\n')}{\n  display:block;\n}\n.workspace:has(#filter-pending:checked) .candidate:not([data-bucket="pending"]),\n.workspace:has(#filter-pending:checked) .matrix-table tbody tr:not([data-bucket="pending"]),\n.workspace:has(#filter-hold:checked) .candidate:not([data-bucket="hold"]),\n.workspace:has(#filter-hold:checked) .matrix-table tbody tr:not([data-bucket="hold"]){\n  display:none;\n}\n.workspace:has(#filter-pending:checked):not(:has(.candidate[data-bucket="pending"])) .filter-empty,\n.workspace:has(#filter-hold:checked):not(:has(.candidate[data-bucket="hold"])) .filter-empty{display:block}\n.workspace:has(#filter-pending:checked):not(:has(.candidate[data-bucket="pending"])) .matrix-block,\n.workspace:has(#filter-hold:checked):not(:has(.candidate[data-bucket="hold"])) .matrix-block{display:none}\n.contact-sheet-frame{margin:8px 0 0}\n.contact-sheet-frame img{display:block;width:100%;max-width:960px;height:auto;border-radius:8px;border:1px solid var(--hairline-strong);background:var(--frame)}\n.contact-sheet-frame figcaption{margin-top:6px;font-size:.8125rem;color:var(--muted)}\n${anyOver100Report ? '@container (width < 680px){.matrix-table{--m4:"1688到深含运"}}\n' : ''}`
    : '';
  const filterPillsHtml = r58
    ? `<label class="pill-btn" for="filter-all"><input class="filter-radio" type="radio" name="wb-filter" id="filter-all" checked>全部 ${escape(numberText(candidates.length))}</label><label class="pill-btn" for="filter-pass"><input class="filter-radio" type="radio" name="wb-filter" id="filter-pass">达标可推进 ${escape(numberText(eligibleCount))}</label><label class="pill-btn" for="filter-pending"><input class="filter-radio" type="radio" name="wb-filter" id="filter-pending">待补证 ${escape(numberText(pendingBucketCount))}</label><label class="pill-btn" for="filter-hold"><input class="filter-radio" type="radio" name="wb-filter" id="filter-hold">淘汰／暂缓 ${escape(numberText(holdCount))}</label>`
    : `<label class="pill-btn" for="filter-all"><input class="filter-radio" type="radio" name="wb-filter" id="filter-all" checked>全部 ${escape(numberText(candidates.length))}</label><label class="pill-btn" for="filter-pass"><input class="filter-radio" type="radio" name="wb-filter" id="filter-pass">达标可推进 ${escape(numberText(eligibleCount))}</label><label class="pill-btn" for="filter-hold"><input class="filter-radio" type="radio" name="wb-filter" id="filter-hold">淘汰／待补 ${escape(numberText(holdCount))}</label>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>${R57_CSS}${r58ExtraCss}</style></head><body><a class="skip-link" href="#cards">跳到候选卡</a><div class="shell"><aside class="side-rail" aria-label="选品索引导航"><div class="rail-brand"><span class="brand-mark" aria-hidden="true"></span><span>选品决策</span></div>${candidates.length ? `<nav class="rail-group" aria-label="候选产品直达"><span class="rail-heading">候选目录</span><a class="rail-link" href="#overview"><span class="rail-link-text">横向对比总览</span><span class="mono-id">${candidates.length}</span></a>${candidates.map((cand, i) => {
    const snap = extractMetricsSnapshot(cand, rev);
    const dot = statusDotInfo(cand, snap, rev).tone;
    const shortName = string(cand.label ?? cand.candidate_id).replace(/[（(|].*$/, '').trim();
    return `<a class="rail-link" href="#candidate-${i + 1}"><span class="rail-link-text">${escape(shortName)}</span><i class="dot dot-${dot}" aria-hidden="true"></i></a>`;
  }).join('')}</nav>` : ''}<div class="rail-group rail-specs-group"><span class="rail-heading">核算基准</span><dl class="rail-specs"><div><dt>目标站点</dt><dd>US FBA</dd></div><div><dt>参考售价</dt><dd>≥ $29.99</dd></div><div><dt>广告前毛利</dt><dd>≥ 30.0%</dd></div><div><dt>国内采购</dt><dd>${r58 ? '≥100套常规' : '100套常规'}</dd></div><div><dt>规则修订</dt><dd>Rev ${escape(result?.profile_revision ?? 57)}</dd></div></dl></div><p class="rail-foot">离线单文件 · 零外部请求</p></aside><main class="workspace"><header class="banner-line"><h1>${escape(title)}</h1>${typeof presentation.summary === 'string' ? `<p class="banner-sub">${escape(presentation.summary)}</p>` : ''}<p class="batch-counts">本轮 ${escape(numberText(candidates.length))} 个候选；完整可比 ${escape(numberText(completeCount))} 个，${headlinePendingText}。${seasonalCounts}${r58OrderRule}</p></header>${candidates.length ? `<div class="sticky-bar" role="region" aria-label="筛选与视图控制"><div class="pill-bar" role="radiogroup" aria-label="候选筛选">${filterPillsHtml}</div><div class="bar-right">${queueLinks ? `<nav class="queue-nav" aria-label="跳转候选队列">${queueLinks}</nav>` : ''}<label class="ring-btn" for="expand-qualifiers"><input class="mode-check" type="checkbox" id="expand-qualifiers">口径说明</label></div></div>${renderComparisonMatrix(candidates, originals, rev)}<p class="filter-empty muted">当前筛选条件下暂无候选款式，请切换至“全部”查看完整列表。</p>` : ''}<section id="cards" aria-label="候选产品卡">${candidates.length ? candidates.map((candidate, index) => (candidate?.queue === 'seasonal_review' ? r57SeasonalCard(object(candidate), originals.get(candidate?.candidate_id), index, rev) : r57SingleCard(object(candidate), originals.get(candidate?.candidate_id), index, rev))).join('') : '<div class="empty-state"><h2>本轮没有候选卡</h2><p class="muted">保留发现与覆盖记录；没有候选不等于市场中没有机会。</p></div>'}</section>${r57NegotiationAppendix(result, batch, rev)}${r57BatchContext(presentation)}<footer class="report-footer"><p>评分反映本轮证据与已确认试评规则。未知不按零计，不把已知部分折算为100分；初步评分、供应验证、主人决定与实际经营效果分别核验。</p><p>规则版本：修订 ${escape(result?.profile_revision ?? '未知')}</p></footer></main></div></body></html>`;
}

// ============================================================================
// Curatorial Studio Gallery Architecture (revision 58+)
// ============================================================================
const R58_ROSE_SHORT_LABELS = {
  profit: '盈利空间',
  suggested_bid_pressure: '竞价压力',
  niche_demand: '需求依据',
  market_entry: '竞争分散',
  normal_newcomer: '新品突破',
  need_fit: '需求契合',
  product_risk_and_operations: '运营风控',
  rights_and_requirements: '权利准入',
};

function buildR58PolarRose(scoreObj) {
  const groups = array(scoreObj?.groups);
  if (!groups.length) return '';
  const cx = 190;
  const cy = 185;
  const maxR = 126;
  const minR = 24;
  const n = groups.length;
  const stepAng = (Math.PI * 2) / n;
  const gap = 0.055;

  const ratios = groups.map(g => {
    const sr = g?.supported_range;
    const w = finite(g?.weight) && g.weight > 0 ? g.weight : 1;
    if (!Array.isArray(sr) || sr.length !== 2 || !sr.every(finite)) return 0;
    return Math.min(1, Math.max(0, ((sr[0] + sr[1]) / 2) / w));
  });

  let bestIdx = 0;
  let bestRatio = -1;
  ratios.forEach((r, idx) => {
    if (r > bestRatio + 1e-9) {
      bestRatio = r;
      bestIdx = idx;
    }
  });

  const guideCircles = [0.33, 0.66, 1].map(f => {
    const r = minR + (maxR - minR) * f;
    return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" class="rose-ring"/>`;
  }).join('');

  const sectors = groups.map((g, idx) => {
    const a0 = -Math.PI / 2 + idx * stepAng + gap;
    const a1 = -Math.PI / 2 + (idx + 1) * stepAng - gap;
    const aMid = (a0 + a1) / 2;
    const ratio = ratios[idx];
    const r = minR + (maxR - minR) * Math.max(0.08, ratio);
    const x0 = cx + Math.cos(a0) * minR;
    const y0 = cy + Math.sin(a0) * minR;
    const x1 = cx + Math.cos(a0) * r;
    const y1 = cy + Math.sin(a0) * r;
    const x2 = cx + Math.cos(a1) * r;
    const y2 = cy + Math.sin(a1) * r;
    const x3 = cx + Math.cos(a1) * minR;
    const y3 = cy + Math.sin(a1) * minR;
    const lx = cx + Math.cos(aMid) * (maxR + 26);
    const ly = cy + Math.sin(aMid) * (maxR + 22);
    const anchor = lx < cx - 14 ? 'end' : lx > cx + 14 ? 'start' : 'middle';
    const isSel = bestRatio > 0 && idx === bestIdx;
    const shortLbl = R58_ROSE_SHORT_LABELS[g.id] ?? GROUP_LABELS[g.id] ?? g.id;
    const fullLbl = GROUP_LABELS[g.id] ?? g.id;
    const d = `M ${x0.toFixed(1)} ${y0.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${x3.toFixed(1)} ${y3.toFixed(1)} A ${minR} ${minR} 0 0 0 ${x0.toFixed(1)} ${y0.toFixed(1)} Z`;
    return `<g class="rose-sector${isSel ? ' is-sel' : ''}">
      <title>${escape(fullLbl)}：${escape(rangeText(g.supported_range))} / ${escape(numberText(g.weight))} 分</title>
      <path d="${d}" class="rose-petal"/>
      <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" class="rose-lbl">${escape(shortLbl)}</text>
    </g>`;
  }).join('');

  const isCrossingR59 = (scoreObj?.profile_revision ?? 0) >= 59 && scoreObj?.diagnostics?.economics?.crossing_margin_floor === true;
  const complete = Array.isArray(scoreObj?.total_range) && (scoreObj?.queue === 'comparable' || isCrossingR59);
  const headlineNum = complete ? rangeText(scoreObj.total_range) : rangeText(scoreObj?.supported_range);
  const denomNum = complete ? '100' : numberText(scoreObj?.covered_weight ?? 100);
  const headlineCap = isCrossingR59 && complete ? '21 项跨线区间总分' : complete ? '21 项综合已核总分' : '21 项已支持累计得分';

  return `<div class="polar-wrap">
    <div class="polar-chart-col">
      <svg viewBox="0 0 380 370" class="rose-svg" role="img" aria-label="八维极坐标玫瑰图谱">
        ${guideCircles}
        ${sectors}
        <circle cx="${cx}" cy="${cy}" r="${minR - 2}" fill="#ffffff"/>
      </svg>
    </div>
    <div class="polar-detail-col">
      <div class="pd-score-lockup">
        <span class="pd-k">${headlineCap}</span>
        <div class="num pd-big">${escape(headlineNum)} <small>/ ${escape(denomNum)}</small></div>
      </div>
      <div class="polar-group-summary">
        ${groups.map((g, idx) => {
          const isSel = bestRatio > 0 && idx === bestIdx;
          return `<div class="pgs-row${isSel ? ' is-sel' : ''}">
            <span>${escape(R58_ROSE_SHORT_LABELS[g.id] ?? GROUP_LABELS[g.id] ?? g.id)}</span>
            <span class="num">${escape(rangeText(g.supported_range))} / ${escape(numberText(g.weight))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function r58CompactTabLabel(label) {
  return string(label, '时段')
    .replace(/(\d)\s*—\s*(\d)/g, '$1–$2')
    .replace(/（[^）]{5,}）$/, '')
    .trim();
}

function r58PolishRangeCopy(text) {
  return string(text).replace(/([0-9%])\s*—\s*([0-9$¥U])/g, '$1–$2');
}

function r58ShortPlinthTitle(cand, pres) {
  if (typeof pres?.short_title === 'string' && pres.short_title.trim()) return pres.short_title.trim();
  const raw = string(cand?.label ?? cand?.candidate_id, '未命名候选').trim();
  const stripped = raw.replace(/[（(|].*$/, '').trim();
  return stripped || raw;
}

function renderR58ExhibitionReel(candidates, originals, rev) {
  if (!candidates.length) return '';
  const cols = Math.min(5, Math.max(2, candidates.length));
  return `<section class="exhibition-reel" style="--reel-cols:${cols}" aria-label="本批候选展列">
    ${candidates.map((cand, idx) => {
      const orig = originals.get(cand?.candidate_id);
      const pres = object(orig?.presentation);
      const snap = extractMetricsSnapshot(cand, rev);
      const eligible = isCandidateEligible(cand, rev);
      const bucket = candidateFilterBucket(cand, rev);
      const idxPad = String(idx + 1).padStart(2, '0');
      const fullTitle = string(cand?.label ?? cand?.candidate_id, `候选 ${idxPad}`);
      const shortTitle = r58ShortPlinthTitle(cand, pres);
      const plinthImg = imageUri(pres.hero_image_data_uri) ?? imageUri(pres.image_data_uri) ?? imageUri(pres.contact_sheet_data_uri);

      let statWord = '待补证';
      let statTone = '';
      if (isPrivateMoldReservedR59(cand, rev)) {
        statWord = '疑似私模留档';
      } else if (eligible && snap.margins) {
        statWord = `${numberText(snap.margins[0] * 100)}% 净毛利`;
        statTone = 'ink-pass';
      } else if (bucket === 'hold') {
        statWord = snap.margins ? `${numberText(snap.margins[1] * 100)}% 归档` : '已归档';
        statTone = 'ink-fail';
      } else if (snap.margins) {
        statWord = `${pctRangeText(snap.margins)} 待核`;
      } else if (snap.stressMargins) {
        statWord = `试算 ${numberText(snap.stressMargins[1] * 100)}%`;
      } else if (snap.supportedRange) {
        statWord = `已得 ${rangeText(snap.supportedRange)} 分`;
      }

      const mTone = snap.marginFloorStatus === 'pass' ? 'ink-pass' : snap.marginFloorStatus === 'fail' ? 'ink-fail' : '';
      const staggerCls = candidates.length >= 3 && idx % 2 === 1 ? ' is-stagger' : '';
      const specimenSub = isPrivateMoldReservedR59(cand, rev) ? '疑似私模／需开模留档' : (QUEUES[cand?.queue] ?? '候选');

      return `<a class="plinth-item${staggerCls}" href="#candidate-${idx + 1}" data-eligible="${eligible ? 'true' : 'false'}" data-bucket="${bucket}">
        ${plinthImg
          ? `<div class="plinth-photo"><img src="${escape(plinthImg)}" alt="${escape(string(pres.image_alt, shortTitle))}" width="960" height="720" decoding="async"></div>`
          : `<div class="plinth-photo plinth-photo-typo"><div class="plinth-specimen"><span class="num ps-big ${mTone}">${pctRangeText(snap.margins)}</span><span class="ps-sub">${escape(specimenSub)}</span></div></div>`}
        <div class="plinth-caption">
          <div class="pc-row1">
            <span class="ed-idx">${idxPad}</span>
            <span class="pc-title" title="${escape(fullTitle)}">${escape(shortTitle)}</span>
          </div>
          <div class="pc-row2">
            <span class="num">${usdRangeText(snap.prices)}</span>
            <span class="pc-sep">/</span>
            <span class="num ${statTone}">${escape(statWord)}</span>
          </div>
          <span class="pc-active-bar" aria-hidden="true"></span>
        </div>
      </a>`;
    }).join('')}
  </section>`;
}

function renderR58SculpturalLedger(snapshot, queueLabel) {
  const marginCls = snapshot.marginFloorStatus === 'pass'
    ? 'ink-pass'
    : snapshot.marginFloorStatus === 'fail'
      ? 'ink-fail'
      : snapshot.marginFloorStatus === 'cross'
        ? ''
        : 'ink-muted';
  let deltaHtml = `<span class="muted">${snapshot.isSensitivity ? '同精度条件试算 · 红线 30%' : '广告前净毛利率 · 红线 30%'}</span>`;
  if (snapshot.margins) {
    if (snapshot.marginFloorStatus === 'pass') {
      const pts = Math.max(0, (snapshot.margins[0] - 0.3) * 100);
      deltaHtml = `<span class="ink-pass">${SVG_UP} +${escape(numberText(pts))} pts 高于红线</span> · <span class="muted">广告前净毛利</span>`;
    } else if (snapshot.marginFloorStatus === 'fail') {
      const pts = (snapshot.margins[1] - 0.3) * 100;
      const targetGoodsHint = snapshot.targetGoodsCnyAt30Pct
        ? ` · <span class="ink-fail">需把拿货价压到 ¥${escape(rangeText(snapshot.targetGoodsCnyAt30Pct))} 才达标</span>`
        : '';
      deltaHtml = `<span class="ink-fail">${SVG_DOWN} ${escape(numberText(pts))} pts 低于红线</span> · <span class="muted">${snapshot.isSensitivity ? '同精度试算' : '广告前净毛利'}</span>${targetGoodsHint}`;
    } else if (snapshot.marginFloorStatus === 'cross' && snapshot.crossingPassSummary && snapshot.crossingBelowSummary) {
      deltaHtml = `<span class="ink-pass">达标可做：${escape(snapshot.crossingPassSummary)}</span> · <span class="ink-fail">未过 30% 红线：${escape(snapshot.crossingBelowSummary)}</span>`;
    }
  }
  const domesticMain = snapshot.cnyTotals
    ? `${escape(rangeText(snapshot.cnyTotals))} 元`
    : usdRangeText(snapshot.domesticDelivered);
  const domesticSub = snapshot.cnyTotals && snapshot.domesticDelivered
    ? `（${usdRangeText(snapshot.domesticDelivered)}）`
    : '';
  const domesticLabel = snapshot.orderUnitsRange && snapshot.orderUnitsRange[1] > 100
    ? `1688到深含运（${escape(rangeText(snapshot.orderUnitsRange))}套）`
    : '1688百套含运';
  const hasSamplePending = Array.isArray(snapshot.sampleCheckItems) && snapshot.sampleCheckItems.length > 0;
  const scoreMain = snapshot.totalRange
    ? `${escape(rangeText(snapshot.totalRange))} / 100`
    : (hasSamplePending
        ? `已得分 ${escape(rangeText(snapshot.supportedRange))} / 已覆盖总权重 ${escape(numberText(snapshot.coveredWeight))}`
        : queueLabel);
  const capDisplay = snapshot.landedCapCny
    ? `¥${escape(rangeText(snapshot.landedCapCny))}`
    : (snapshot.landedCapUsd ? usdRangeText(snapshot.landedCapUsd) : '待补证');
  const marginStr = pctRangeText(snapshot.margins);
  const isRangeMargin = marginStr.includes('–') || marginStr.includes('至');

  return `<div class="sculptural-metrics hero-stat">
    <div class="sm-primary-row">
      <div class="sm-main-num">
        <span class="sm-label">广告前净毛利率（硬红线 30.0%）</span>
        <p class="hero-stat-val${isRangeMargin ? ' is-range' : ''} num ${marginCls}">${marginStr}</p>
      </div>
      <div class="sm-side-pair">
        <div class="sm-side-item">
          <span>保 30% 到深封顶</span>
          <strong class="num">${capDisplay}</strong>
        </div>
        <div class="sm-side-item">
          <span>单件净留存</span>
          <strong class="num">${usdRangeText(snapshot.contributions)}</strong>
        </div>
      </div>
    </div>
    <p class="hero-stat-sub">${deltaHtml}</p>
  </div>
  <dl class="side-ledger">
    <div><dt>美站参照价</dt><dd>${usdRangeText(snapshot.prices)}</dd></div>
    <div><dt>${domesticLabel}</dt><dd>${domesticMain}${domesticSub}</dd></div>
    <div><dt>扣15%广告毛利</dt><dd>${pctRangeText(snapshot.adMargins)}</dd></div>
    <div><dt>广告前单件贡献</dt><dd>${usdRangeText(snapshot.contributions)}</dd></div>
    <div><dt>21项综合评分</dt><dd><strong>${escape(scoreMain)}</strong></dd></div>
    <div><dt>已支持 ／ 权重</dt><dd class="muted">${escape(rangeText(snapshot.supportedRange))} 分 ／ ${escape(numberText(snapshot.coveredWeight))}</dd></div>
  </dl>`;
}

function r58ContactSheetFigure(presentation, label, prefix) {
  const sheet = imageUri(presentation?.contact_sheet_data_uri);
  if (!sheet) return '';
  const caption = string(presentation?.contact_sheet_caption, '4×4 类目视觉聚类联系表（用于确认同形态同任务可比集与价位带切分）');
  const altText = string(presentation?.contact_sheet_alt, `${label} 视觉聚类联系表`);
  const zoomId = `${prefix}-sheet-zoom`;
  return `<section class="ledger-section" data-section="contact-sheet">
    <h3>视觉聚类联系表（4×4）</h3>
    <figure class="contact-sheet-frame">
      <a class="zoom-trigger" href="#${zoomId}" aria-label="放大查看 ${escape(label)} 视觉聚类联系表">
        <img src="${escape(sheet)}" alt="${escape(altText)}" loading="lazy" decoding="async">
      </a>
      <figcaption><span>${escape(caption)}</span><a class="zoom-hint" href="#${zoomId}">全屏高清检视</a></figcaption>
    </figure>
    <div id="${zoomId}" class="css-lightbox" role="dialog" aria-label="${escape(label)} 视觉聚类联系表全屏大图">
      <a class="lb-backdrop" href="#${prefix}" aria-label="关闭大图"></a>
      <div class="lb-sheet">
        <div class="lb-head"><strong>${escape(label)} · 视觉聚类联系表（4×4）</strong><a class="lb-close" href="#${prefix}">关闭返回</a></div>
        <img src="${escape(sheet)}" alt="${escape(altText)}" loading="lazy" decoding="async">
      </div>
    </div>
  </section>`;
}

function r58ReferenceImageFigure(presentation, label, prefix) {
  const image = imageUri(presentation?.image_data_uri);
  if (!image) return '';
  const altText = string(presentation?.image_alt, `${label} 原始参考与核验存证`);
  const caption = string(presentation?.image_caption, '所附参考与报价核验截图，供核对具体规格');
  const zoomId = `${prefix}-img-zoom`;
  return `<section class="ledger-section">
    <h3>实物规格与货源原始截图</h3>
    <figure class="contact-sheet-frame">
      <a class="zoom-trigger" href="#${zoomId}" aria-label="放大查看 ${escape(label)} 原始核验图">
        <img src="${escape(image)}" alt="${escape(altText)}" loading="lazy" decoding="async">
      </a>
      <figcaption><span>${escape(caption)}</span><a class="zoom-hint" href="#${zoomId}">全屏高清检视</a></figcaption>
    </figure>
    <div id="${zoomId}" class="css-lightbox" role="dialog" aria-label="${escape(label)} 原始核验大图">
      <a class="lb-backdrop" href="#${prefix}" aria-label="关闭大图"></a>
      <div class="lb-sheet">
        <div class="lb-head"><strong>${escape(label)} · 原始核验截图</strong><a class="lb-close" href="#${prefix}">关闭返回</a></div>
        <img src="${escape(image)}" alt="${escape(altText)}" loading="lazy" decoding="async">
      </div>
    </div>
  </section>`;
}

const CONCEPT_IMAGE_DATA_URI_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function validConceptDataUri(value) {
  if (typeof value !== 'string' || !CONCEPT_IMAGE_DATA_URI_RE.test(value)) return null;
  return imageUri(value);
}

function r58CleanCopy(value) {
  return r58PolishRangeCopy(string(value)).replace(/—/g, '–');
}

function sanitizeR58ConceptImages(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const validUri = validConceptDataUri(item.data_uri);
    if (!validUri) return null;
    return {
      data_uri: validUri,
      title: sanitizeTextPaths(safeText(item.title ?? '')),
      caption: sanitizeTextPaths(safeText(item.caption ?? '')),
      alt: sanitizeTextPaths(safeText(item.alt ?? '')),
    };
  }).filter(Boolean);
}

function formatR58ReviewerModel(rawModel) {
  const m = string(rawModel).trim();
  if (!m) return '';
  const lower = m.toLowerCase();
  if (lower === 'gpt-6.2-astra') return 'GPT-6.2 Astra';
  if (lower === 'gpt-6-astra') return 'GPT-6 Astra';
  if (lower === 'gpt-6.1-terra') return 'GPT-6.1 Terra';
  if (lower === 'gpt-6-luna') return 'GPT-6 Luna';
  return m;
}

function resolveR58EvidenceReview(result, original) {
  const raw = result?.evidence_review ?? original?.evidence_review ?? original?.presentation?.evidence_review;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function resolveR58ConceptImages(result, original) {
  const raw = result?.concept_images ?? original?.concept_images ?? original?.presentation?.concept_images;
  return Array.isArray(raw) ? raw : [];
}

const SHAREABLE_PII_KEY_RE = /^(?:(?:recipient|receiver|contact|consignee|buyer|customer)(?:_?name)?|(?:ship(?:ping)?|delivery|street|home|contact)_?address|phone|phone_number|mobile|tel|telephone)$/i;

function redactShareableReviewTree(value, parentKey = '') {
  if (SHAREABLE_PII_KEY_RE.test(String(parentKey || '').trim()) && typeof value === 'string' && value.trim()) {
    return '[REDACTED_PII]';
  }
  if (typeof value === 'string') {
    return sanitizeDiagnosticText(value)
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
      .replace(/(?:\+?1[-.\s]?)?\(\d{3}\)\s*\d{3}[-.\s]\d{4}\b/g, '[REDACTED_PHONE]')
      .replace(/(?:\+1[-.\s]|\b(?:tel|telephone|phone|mobile|cell|fax)\s*[:=]?\s*\+?1?[-.\s]?)\b[2-9]\d{2}[-.\s]\d{3}[-.\s]\d{4}\b/gi, '[REDACTED_PHONE]')
      .replace(/\b[2-9]\d{2}[.-]\d{3}[.-]\d{4}\b/g, '[REDACTED_PHONE]')
      .replace(/\b(contact|recipient|receiver|receiver_name|attn|consignee|ship\s*to)\s*[:=]\s*[^\r\n;；|]+/gi, '$1:[REDACTED_NAME]')
      .replace(/(收件人|联系人)\s*[:：]\s*[^\r\n;；|]+/g, '$1:[REDACTED_NAME]')
      .replace(/\b(address|street\s*address|ship(?:ping)?\s*address)\s*[:=]\s*[^\r\n;；|]+/gi, '$1:[REDACTED_ADDRESS]')
      .replace(/\b\d{1,6}\s+[A-Za-z][A-Za-z0-9.\s]{1,35}\b(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Way|Parkway|Pkwy\.?)(?:\s*,?\s*(?:Suite|Ste\.?|Apt\.?|Unit|#)\s*[A-Za-z0-9-]+)?\b/gi, '[REDACTED_ADDRESS]')
      .replace(/(收货地址|联系地址|详细地址)\s*[:：]\s*[^\r\n;；]+/g, '$1:[REDACTED_ADDRESS]');
  }
  if (Array.isArray(value)) return value.map(item => redactShareableReviewTree(item, parentKey));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[redactShareableReviewTree(k)] = redactShareableReviewTree(v, k);
    }
    return out;
  }
  return value;
}

function renderR58EvidenceReview(result, original, reportOptions = {}, rev = 58) {
  const raw = resolveR58EvidenceReview(result, original);
  if (!raw) return '';
  const sanitizedPaths = sanitizeDisplayTree(raw);
  const ev = rev >= 59 ? redactShareableReviewTree(sanitizedPaths) : sanitizedPaths;
  const body = ev.review && typeof ev.review === 'object' && !Array.isArray(ev.review)
    ? ev.review
    : ev.output && typeof ev.output === 'object' && !Array.isArray(ev.output)
      ? ev.output
      : ev;
  const rawStatus = string(ev.status ?? ev.state ?? body.status).trim();
  const statusKey = rawStatus.toLowerCase();
  const subjects = array(body.subjects ?? ev.subjects).filter(s => s && typeof s === 'object' && !Array.isArray(s));
  const contradictions = array(body.contradictions ?? ev.contradictions).filter(Boolean);
  const gaps = array(body.gaps ?? ev.gaps).filter(Boolean);
  const conclusion = string(body.conclusion ?? ev.conclusion ?? ev.summary ?? ev.reason).trim();

  const answers = array(body.answers ?? ev.answers).filter(a => a && typeof a === 'object' && !Array.isArray(a));
  const effortName = string(ev.reasoning_effort ?? ev.effort).trim();
  const reviewId = string(body.review_id ?? ev.review_id).trim();
  const packetSha = string(body.packet_sha256 ?? ev.packet_sha256).trim();
  const envCandId = string(ev.candidate_id).trim();
  const expectedCandId = string(result?.candidate_id ?? result?.id ?? original?.id).trim();
  const candMatches = Boolean(expectedCandId && envCandId && envCandId === expectedCandId);
  const envSpecSha = string(ev.form_spec_sha256).trim();
  const expectedSpecSha = string(original?.spec_sha256 ?? result?.spec_sha256).trim();
  const specMatches = !expectedSpecSha || (Boolean(envSpecSha) && envSpecSha === expectedSpecSha);

  const validSubjects = subjects.length > 0 && subjects.every(s => {
    const sid = string(s?.subject_id).trim();
    const disp = string(s?.disposition).trim();
    if (!sid || !['included', 'excluded', 'pending'].includes(disp)) return false;
    if ((disp === 'included' || disp === 'excluded') && array(s?.evidence_ids).filter(id => string(id).trim()).length === 0) {
      return false;
    }
    return true;
  });
  const validAnswers = answers.length > 0 && answers.every(a => {
    const qid = string(a?.question_id).trim();
    const st = string(a?.status).trim();
    if (!qid || !['answered', 'pending'].includes(st)) return false;
    if (st === 'answered' && array(a?.evidence_ids).filter(id => string(id).trim()).length === 0) return false;
    return true;
  });

  const execStatusKey = string(ev.execution_status ?? body.execution_status).trim().toLowerCase();
  const contentStatusKey = string(ev.content_status ?? body.content_status).trim().toLowerCase();
  const isCommissionedAstra = /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(string(ev.model).trim()) && ['xhigh', 'max'].includes(effortName);

  // P1-16: Verify saved execution receipt on disk before awarding `已复核` or reviewer attribution!
  const receiptCheck = (raw.validated_envelope === true && statusKey === 'ready')
    ? verifySavedCodexReceipt(raw, {
        receiptStoreDir: reportOptions?.receiptStoreDir ?? null,
        allowTestDouble: reportOptions?.allowTestDoubleReceipts === true,
        expectedCandidateId: expectedCandId || null,
        expectedFormSpecSha256: expectedSpecSha || null,
        allowStaleSpec: rev >= 59,
      })
    : { verified: false };

  const reviewerLabel = receiptCheck.verified === true
    ? string(receiptCheck.reviewer_label).trim()
    : (ev.execution_provenance === 'injected_executor' && ['xhigh', 'max'].includes(effortName)
        ? `Synthetic Executor · ${effortName}`
        : '');

  const hasRecordedSpecSha = /^[0-9a-f]{64}$/.test(envSpecSha);
  const isStaleSpecReview = rev >= 59 &&
    (!specMatches || ev.stale_spec === true || receiptCheck.stale_spec === true) &&
    hasRecordedSpecSha;
  const rawReviewedAt = string(ev.reviewed_at ?? receiptCheck.reviewed_at ?? '').trim();
  const reviewedAtShort = rawReviewedAt ? rawReviewedAt.slice(0, 10) : '';

  const isValidatedReviewedEnvelope = Boolean(
    receiptCheck.verified === true &&
    raw.validated_envelope === true &&
    statusKey === 'ready' &&
    execStatusKey === 'completed' &&
    contentStatusKey === 'usable' &&
    isCommissionedAstra &&
    body.schema_version === 'evidence-review-draft-v1' &&
    reviewId &&
    /^[0-9a-f]{64}$/.test(packetSha) &&
    validSubjects &&
    validAnswers &&
    conclusion &&
    reviewerLabel &&
    candMatches &&
    (specMatches || isStaleSpecReview),
  );
  const includedCount = subjects.filter(s => s?.disposition === 'included').length;
  const excludedCount = subjects.filter(s => s?.disposition === 'excluded').length;
  const pendingCount = subjects.filter(s => s?.disposition === 'pending').length;
  const pendingAnswerCount = answers.filter(a => a?.status === 'pending').length;
  const hasOpenAuditItems = pendingCount > 0 || pendingAnswerCount > 0 || contradictions.length > 0 || gaps.length > 0;

  let statusInfo = { tone: 'muted', text: '未启用' };
  if (
    rawStatus === '待恢复' ||
    ['pending_recovery', 'in_progress', 'recovering', 'unknown'].includes(statusKey) ||
    ['pending_recovery', 'in_progress', 'recovering', 'unknown'].includes(execStatusKey)
  ) {
    statusInfo = { tone: 'pending', text: '待恢复' };
  } else if (rawStatus === '未启用' || ['disabled', 'not_submitted', 'off', 'unavailable', 'skipped'].includes(statusKey)) {
    statusInfo = { tone: 'muted', text: '未启用' };
  } else if (isValidatedReviewedEnvelope) {
    statusInfo = isStaleSpecReview
      ? { tone: 'pending', text: '已复核 · 基于旧版参数复核' }
      : (rev >= 59 && hasOpenAuditItems
          ? { tone: 'pending', text: '已复核 · 含待定／冲突项' }
          : { tone: 'pass', text: '已复核' });
  } else if (['failed_known', 'rejected', 'invalid', 'refused', 'error'].includes(statusKey)) {
    statusInfo = { tone: 'fail', text: '未启用' };
  }

  const hasDispositions = isValidatedReviewedEnvelope;

  const renderContradiction = item => {
    if (typeof item === 'string') return `<li>${escape(r58CleanCopy(item))}</li>`;
    const row = object(item);
    const evIds = array(row.conflicting_evidence_ids ?? row.evidence_ids ?? row.evidence)
      .map(id => string(id).trim())
      .filter(Boolean);
    const affectedIds = [
      ...array(row.subject_ids),
      ...array(row.criterion_ids),
      ...array(row.question_ids),
      ...array(row.affected_ids),
    ].map(id => string(id).trim()).filter(Boolean);
    const desc = string(
      row.disagreement ?? row.description ?? row.summary ?? row.reason ?? row.note ?? row.text ?? readableSanitized(row),
    ).trim();
    const idLead = evIds.length
      ? `${evIds.map(id => `<code class="mono-id rt-conflict-id">${escape(r58CleanCopy(id))}</code>`).join(' <span class="pc-sep">/</span> ')}${desc ? ' · ' : ''}`
      : '';
    const affSuffix = affectedIds.length
      ? ` <span class="mono-id">（关联 ${affectedIds.map(id => escape(r58CleanCopy(id))).join('、')}）</span>`
      : '';
    return `<li>${idLead}<span>${escape(r58CleanCopy(desc))}</span>${affSuffix}</li>`;
  };

  const renderGap = item => {
    if (typeof item === 'string') return `<li>${escape(r58CleanCopy(item))}</li>`;
    const row = object(item);
    const missing = string(
      row.missing_information ?? row.missing_evidence ?? row.missing ?? row.gap ?? row.summary ?? row.description ?? row.label,
    ).trim();
    const why = string(row.why_it_matters ?? row.impact ?? row.reason ?? row.importance).trim();
    const resolveWith = string(
      row.resolution_evidence ?? row.what_would_resolve_it ?? row.required_evidence ?? row.resolution ?? row.next_step,
    ).trim();
    const affectedIds = [
      ...array(row.affected_ids),
      ...array(row.subject_ids),
      ...array(row.criterion_ids),
      ...array(row.question_ids),
    ].map(id => string(id).trim()).filter(Boolean);
    const affTag = affectedIds.length
      ? ` <span class="mono-id">[${affectedIds.map(id => escape(r58CleanCopy(id))).join(', ')}]</span>`
      : '';
    return `<li><strong class="rt-item-lead">${escape(r58CleanCopy(missing || '待补关键证据'))}</strong>${affTag}${why ? ` · <span>关键影响：${escape(r58CleanCopy(why))}</span>` : ''}${resolveWith ? `<p class="muted">补证路径：${escape(r58CleanCopy(resolveWith))}</p>` : ''}</li>`;
  };

  return `<section class="quiet-surface rt-audit" data-section="evidence-review" aria-label="独立红队复核">
    <div class="section-head rt-head">
      <h3>独立红队复核 · Red-Team Audit</h3>
      <span class="muted">顾问式证据复核 · 不改动 21 项计分</span>
    </div>
    <div class="rt-meta-row">
      <span class="state-inline state-${statusInfo.tone}"><i class="dot" aria-hidden="true"></i>${escape(statusInfo.text)}</span>
      ${reviewerLabel ? `<span class="pc-sep">·</span><span class="rt-reviewer">${escape(r58CleanCopy(reviewerLabel))}</span>` : ''}
      ${reviewId ? `<span class="pc-sep">·</span><span class="mono-id">${escape(r58CleanCopy(reviewId))}</span>` : ''}${isValidatedReviewedEnvelope && isStaleSpecReview && reviewedAtShort ? `<span class="pc-sep">·</span><span class="muted">复核于 ${escape(r58CleanCopy(reviewedAtShort))}</span>` : ''}
    </div>
    ${hasDispositions ? `<div class="rt-dispositions" aria-label="对标样本处置统计">
      <span class="rt-disp-label">对标样本核定</span>
      <span class="rt-disp-stats num">
        <span>纳入 <span class="mono-id">included</span> <strong class="ink-pass">${escape(numberText(includedCount))}</strong></span>
        <span class="pc-sep">/</span>
        <span>排除 <span class="mono-id">excluded</span> <strong class="ink-fail">${escape(numberText(excludedCount))}</strong></span>
        <span class="pc-sep">/</span>
        <span>待定 <span class="mono-id">pending</span> <strong>${escape(numberText(pendingCount))}</strong></span>
      </span>
    </div>` : ''}
    ${conclusion ? `<p class="rt-conclusion">${escape(r58CleanCopy(conclusion))}</p>` : ''}
    ${contradictions.length ? `<div class="rt-subblock">
      <strong class="rt-subheading">证据冲突点 · ${escape(numberText(contradictions.length))}</strong>
      <ul class="rt-list">${contradictions.map(renderContradiction).join('')}</ul>
    </div>` : ''}
    ${gaps.length ? `<div class="rt-subblock">
      <strong class="rt-subheading">缺失证据与影响 · ${escape(numberText(gaps.length))}</strong>
      <ul class="rt-list">${gaps.map(renderGap).join('')}</ul>
    </div>` : ''}
  </section>`;
}

function renderR58ConceptPlinth(result, original, cardLabel, prefix) {
  const validItems = sanitizeR58ConceptImages(resolveR58ConceptImages(result, original)) ?? [];
  if (!validItems.length) return '';
  const cleanCardLabel = r58CleanCopy(cardLabel);
  return `<section class="ledger-section concept-plinth-section" data-section="concept-plinth" aria-label="微创新改款概念展台">
    <div class="section-head">
      <h3>微创新改款概念 · Concept Plinth</h3>
      <span class="muted">选配概念示意 · 非实拍大货存证</span>
    </div>
    <div class="concept-plinth-grid">
      ${validItems.map((item, idx) => {
        const idxStr = String(idx + 1).padStart(2, '0');
        const zoomId = `${prefix}-concept-${idx + 1}-zoom`;
        const titleText = r58CleanCopy(item.title.trim() || `改款概念方案 ${idxStr}`);
        const captionText = r58CleanCopy(item.caption.trim() || '基于已验证痛点的轻改进打样概念示意，量产前须以实物打样与报价核验为准。');
        const altText = r58CleanCopy(item.alt.trim() || `${cleanCardLabel} · ${titleText}`);
        return `<figure class="concept-plinth-card">
          <a class="zoom-trigger concept-plinth-stage" href="#${zoomId}" aria-label="放大查看 ${escape(titleText)}">
            <img src="${escape(item.data_uri)}" alt="${escape(altText)}" loading="lazy" decoding="async">
          </a>
          <figcaption class="concept-plinth-meta">
            <div class="cp-title-row">
              <span class="ed-idx">${idxStr}</span>
              <strong class="cp-title">${escape(titleText)}</strong>
              <a class="zoom-hint" href="#${zoomId}">全屏检视</a>
            </div>
            <p class="cp-caption">${escape(captionText)}</p>
          </figcaption>
        </figure>
        <div id="${zoomId}" class="css-lightbox" role="dialog" aria-label="${escape(cleanCardLabel)} · ${escape(titleText)} 概念大图">
          <a class="lb-backdrop" href="#${prefix}" aria-label="关闭大图"></a>
          <div class="lb-sheet">
            <div class="lb-head"><strong>${escape(cleanCardLabel)} · ${escape(titleText)}</strong><a class="lb-close" href="#${prefix}">关闭返回</a></div>
            <img src="${escape(item.data_uri)}" alt="${escape(altText)}" loading="lazy" decoding="async">
            <p class="lb-caption muted">${escape(captionText)}</p>
          </div>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

function r59PriceBandBannersAndObservationBar(original, rev = 58) {
  if (rev < 59 || !original || typeof original !== 'object') return '';
  const pb = object(original.price_band_analysis);
  const refPrice = object(original?.screening?.reference_price_usd);
  const pres = object(original?.presentation);
  const mktObs = object(original?.market_observation);

  const isAllYoungBlueOcean = Boolean(
    pb.all_young_niche === true ||
    refPrice.all_young_niche === true ||
    pb.top_amber_banner,
  );
  const bannerText = typeof pb.top_amber_banner === 'string' && pb.top_amber_banner.trim()
    ? pb.top_amber_banner.trim()
    : '全员 90 天内新品蓝海，暂无一年期老品稳态价';
  const growthNote = pb.mature_regular_band?.growth_supplement_used === true && typeof pb.mature_regular_band?.source_note === 'string'
    ? pb.mature_regular_band.source_note
    : '';

  const outOfBandPeers = [
    ...array(pb.observed_out_of_band_peers),
    ...array(mktObs.observed_out_of_band_peers),
    ...array(pres.observed_out_of_band_peers),
  ].filter(p => p && typeof p === 'object' && string(p.asin).trim());
  const dedupedPeers = [];
  const seenPeerAsins = new Set();
  for (const p of outOfBandPeers) {
    const a = string(p.asin).trim().toUpperCase();
    if (seenPeerAsins.has(a)) continue;
    seenPeerAsins.add(a);
    dedupedPeers.push(p);
  }

  let html = '';
  if (isAllYoungBlueOcean) {
    html += `<section class="quiet-surface" data-section="ultra-new-blue-ocean-banner" aria-label="超新蓝海提醒">
      <p><span class="state-inline state-pending"><i class="dot" aria-hidden="true"></i><strong>${escape(bannerText)}</strong></span> · <span class="muted">已按剔除 ≥20% 大额券后的在售常规价核算参考账，不阻断评估。</span></p>
    </section>`;
  } else if (growthNote) {
    html += `<section class="quiet-surface" data-section="growth-tier-supplement-note" aria-label="成长期补位说明">
      <p class="muted"><strong>三档顺位补位说明：</strong>${escape(sanitizeTextPaths(growthNote))}</p>
    </section>`;
  }
  if (dedupedPeers.length > 0) {
    html += `<section class="quiet-surface" data-section="out-of-band-observation-bar" aria-label="移出主价位带竞品观察栏">
      <div class="section-head"><h3>竞品观察栏（移出主价位带明牌留痕）</h3><span class="muted">保留原价与移出理由 · 严禁静默删除</span></div>
      <ul class="brief-list">${dedupedPeers.map(p => {
        const pr = finite(p.original_price_usd ?? p.net_price_usd ?? p.price_usd)
          ? `US$ ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(p.original_price_usd ?? p.net_price_usd ?? p.price_usd)}`
          : '价格未知';
        const reason = sanitizeTextPaths(string(p.reason ?? p.reason_zh ?? p.bucket, '观察分流'));
        return `<li><span class="mono-id">${escape(string(p.asin).trim().toUpperCase())}</span> · 原价 <strong>${escape(pr)}</strong> · <span>${escape(reason)}</span></li>`;
      }).join('')}</ul>
    </section>`;
  }
  return html;
}

function r59SamplePendingBanner(snapshot, rev = 58) {
  if (rev < 59 || !Array.isArray(snapshot?.sampleCheckItems) || snapshot.sampleCheckItems.length === 0) return '';
  return `<section class="quiet-surface" data-section="sample-pending-checklist" aria-label="拿样与旺旺待核清单">
    <div class="section-head">
      <h3><span class="state-inline state-pending"><i class="dot" aria-hidden="true"></i>拿样／旺旺待核清单</span></h3>
      <span class="num"><strong>已得分 ${escape(rangeText(snapshot.supportedRange))} / 已覆盖总权重 ${escape(numberText(snapshot.coveredWeight))}</strong></span>
    </div>
    <ul class="brief-list">${snapshot.sampleCheckItems.map(it =>
      `<li><strong>${escape(string(it.label ?? it.id))}（${escape(numberText(it.weight))} 分留空）</strong> · <span>${escape(r58CleanCopy(string(it.reason)))}</span></li>`
    ).join('')}</ul>
  </section>`;
}

function r59CompetitionReferenceBar(original, rev = 58) {
  if (rev < 59) return '';
  const mkt = object(original?.market);
  const pres = object(original?.presentation);
  const rawMedRev = mkt.top10_median_reviews ?? mkt.median_reviews ?? mkt.top10MedianReviews ?? pres.top10_median_reviews ?? null;
  const medRev = finite(rawMedRev) ? rawMedRev : (finite(rawMedRev?.value) ? rawMedRev.value : null);
  const rawAvgRev = mkt.category_avg_reviews ?? mkt.avg_reviews ?? mkt.avgReviews ?? pres.category_avg_reviews ?? null;
  const avgRev = finite(rawAvgRev) ? rawAvgRev : (finite(rawAvgRev?.value) ? rawAvgRev.value : null);

  const rawAmz = mkt.amz_sales_share ?? mkt.amzSalesRatio ?? mkt.amz_unit_share ?? pres.amz_sales_share ?? null;
  const amzNum = finite(rawAmz) ? rawAmz : (finite(rawAmz?.value) ? rawAmz.value : null);
  const amzFrac = amzNum !== null && amzNum >= 0 ? (amzNum > 1 ? amzNum / 100 : amzNum) : null;

  const rawSellers = mkt.seller_count ?? mkt.total_sellers ?? mkt.sellers ?? mkt.sellerCount ?? pres.seller_count ?? null;
  const sellerCnt = finite(rawSellers) && rawSellers >= 0
    ? Math.round(rawSellers)
    : (finite(rawSellers?.value) && rawSellers.value >= 0 ? Math.round(rawSellers.value) : null);

  if (medRev === null && avgRev === null && amzFrac === null && sellerCnt === null) return '';

  const rawSampleCnt = mkt.top10_review_sample_count ?? pres.top10_review_sample_count ?? null;
  const sampleCnt = finite(rawSampleCnt) && rawSampleCnt >= 0 ? Math.round(rawSampleCnt) : null;

  const items = [];
  if (medRev !== null && medRev >= 0) {
    const tone = medRev < 100 ? 'pass' : medRev < 500 ? 'pending' : 'fail';
    const word = medRev < 100 ? '绿 · 低门槛' : medRev < 500 ? '黄 · 中等门槛' : '红 · 高评论壁垒';
    const sampleNote = sampleCnt !== null && sampleCnt < 10 ? ` · 样本 ${sampleCnt}/10 款` : '';
    items.push(`<div><dt>Top-10 评论中位数</dt><dd><span class="state-inline state-${tone}"><i class="dot" aria-hidden="true"></i>${escape(numberText(medRev))} 条（${word}${escape(sampleNote)}）</span></dd></div>`);
  }
  if (avgRev !== null && avgRev >= 0) {
    const avgContext = medRev !== null ? '类目均值对照' : '无足够 Top-10 明细，仅列类目均值';
    items.push(`<div><dt>类目平均评论数（参考）</dt><dd><span class="state-inline state-muted"><i class="dot" aria-hidden="true"></i>${escape(numberText(avgRev))} 条（${avgContext}）</span></dd></div>`);
  }
  if (amzFrac !== null) {
    const pctStr = `${numberText(amzFrac * 100)}%`;
    const tone = amzFrac < 0.10 ? 'pass' : amzFrac < 0.30 ? 'pending' : 'fail';
    const word = amzFrac >= 0.50
      ? '红预警 · 自营超第三方，强烈建议放弃'
      : amzFrac >= 0.30
        ? '红预警 · 自营占比较高'
        : amzFrac >= 0.10
          ? '黄 · 留意自营竞争'
          : '绿 · 自营占比低';
    items.push(`<div><dt>亚马逊自营（AMZ）销量占比</dt><dd><span class="state-inline state-${tone}"><i class="dot" aria-hidden="true"></i>${escape(pctStr)}（${word}）</span></dd></div>`);
  }
  if (sellerCnt !== null) {
    const isBlueOcean = sellerCnt >= 1 && sellerCnt < 15;
    const tone = isBlueOcean ? 'pass' : 'muted';
    const text = isBlueOcean
      ? `小蓝海仅 ${numberText(sellerCnt)} 家，非巨头垄断`
      : `${numberText(sellerCnt)} 家在售`;
    items.push(`<div><dt>在售卖家总数</dt><dd>${isBlueOcean ? `<span class="state-inline state-${tone}"><i class="dot" aria-hidden="true"></i>${escape(text)}</span>` : escape(text)}</dd></div>`);
  }

  return `<div class="quiet-surface" data-section="competition-reference" aria-label="竞争分析补充参考">
    <div class="section-head"><h3>竞争分析补充参考</h3><span class="muted">复用卖家精灵数据 · 不改动 100 分权重</span></div>
    <dl class="side-ledger">${items.join('')}</dl>
  </div>`;
}

function r58PeriodPanel(period, presentation, registry, prefix, panelIndex, rev = 58, original = null) {
  const isCrossingR59 = rev >= 59 && period?.diagnostics?.economics?.crossing_margin_floor === true;
  const hasSamplePendingPeriodR59 = rev >= 59 && Array.isArray(period?.sample_check_items) && period.sample_check_items.length > 0;
  const complete = Array.isArray(period.total_range) && (period.queue === 'comparable' || isCrossingR59);
  const gaps = array(period.items).filter(item => item.status === 'needs_evidence');
  const ineligible = array(period.items).filter(item => item.status === 'ineligible');
  const conditions = array(period.screening?.conditions).filter(condition => condition.status !== 'pass');
  const economics = object(period.diagnostics?.economics);
  const periodScenarios = array(economics.scenarios);
  const contributions = periodScenarios.map(scenario => scenario?.contribution?.value);
  const contribution = contributions.length && contributions.every(finite) && periodScenarios.every(isScoredSupportedR58)
    ? [Math.min(...contributions), Math.max(...contributions)]
    : null;
  const margin = array(economics.margin_range).length === 2 ? economics.margin_range.map(value => value * 100) : null;
  const label = hasSamplePendingPeriodR59 ? '淡季入围（含拿样待核）' : ({ excluded: '本时段排除', deferred: '本时段暂缓' }[period.queue] ?? QUEUES[period.queue] ?? '待补证');
  const incomplete = hasSamplePendingPeriodR59
    ? `已得分 ${escape(rangeText(period.supported_range))} / 已覆盖总权重 ${escape(numberText(period.covered_weight))}`
    : (period.queue === 'excluded' ? '本经营时段不满足筛选条件，不列完整总分' :
      period.queue === 'deferred' ? '本经营时段暂缓，不列完整总分' : '本经营时段完整总分待补证');

  return `<section class="operating-period tab-panel tab-p${panelIndex}" data-operating-period="${escape(period.id)}" data-queue="${escape(period.queue)}">
    ${buildR58PolarRose(period)}
    <div class="period-meta-line">
      <div>
        <strong>${escape(r58PolishRangeCopy(period.label))}</strong> · <span class="muted">${label} · 适用 ${escape(array(period.months).join('、'))}月</span>
        ${typeof presentation.summary === 'string' ? `<p class="period-note">${escape(r58PolishRangeCopy(presentation.summary))}</p>` : ''}
      </div>
      <div class="period-inline-nums num">
        <span>毛利 <strong>${margin ? `${escape(rangeText(margin))}%` : (rev >= 59 && typeof period.unpublished_peak_note === 'string' && period.unpublished_peak_note.trim() ? escape(period.unpublished_peak_note.trim()) : '未知')}</strong></span>
        <span>贡献 <strong>${contribution ? `US$ ${escape(rangeText(contribution))}` : '未知'}</strong></span>
        <span>总分 <strong>${complete ? `${escape(rangeText(period.total_range))} / 100` : incomplete}</strong></span>
      </div>
    </div>
    <p class="muted coverage-line">已支持分数 ${escape(rangeText(period.supported_range))}；已计分权重 ${escape(numberText(period.covered_weight))} / 100；不满足合格评分条件 ${ineligible.length} 项；待补证 ${gaps.length} 项。${period.conditional_total_range ? `满足本时段准入后可能范围 ${escape(rangeText(period.conditional_total_range))}（数学界限，非预测）。` : ''}</p>
    ${conditions.length ? `<p class="muted coverage-line">本时段筛选：${conditions.map(condition => `${escape(STATES[condition.status] ?? condition.status)}：${escape(reasonText(condition.reason))}`).join('；')}</p>` : ''}
    ${r57KeyValueSection('本时段核算参数', presentation.facts)}
    ${r57EconomicWaterfall(period, `${prefix}-econ-${period.id}`, rev, original)}
    ${r59CompetitionReferenceBar(original, rev)}<section class="ledger-section">
      <div class="section-head"><h3>21 项评分明细</h3><span class="muted">8 大维度 · 点击编号直达原始证据</span></div>
      ${r57ScoreRows(period, registry, prefix, rev)}
    </section>
    ${r57NewcomerDetails(period, rev)}
  </section>`;
}

function r59CalibrationSummarySection(original, rev = 58) {
  if (rev < 59) return '';
  const spApi = original?.sp_api_calibration && typeof original.sp_api_calibration === 'object' ? sanitizeDisplayTree(original.sp_api_calibration) : null;
  const peerPkg = original?.peer_package_calibration && typeof original.peer_package_calibration === 'object' ? sanitizeDisplayTree(original.peer_package_calibration) : null;
  if (!spApi && !peerPkg) return '';
  const rows = [];
  if (spApi) {
    const pkg = spApi.official_pkg;
    const pLen = pkg?.length_in ?? pkg?.length;
    const pWid = pkg?.width_in ?? pkg?.width;
    const pHei = pkg?.height_in ?? pkg?.height;
    const pWt = pkg?.unit_weight_lb ?? pkg?.weight;
    const pkgStr = finite(pLen) && finite(pWid) && finite(pHei) && finite(pWt)
      ? `${numberText(pLen)} × ${numberText(pWid)} × ${numberText(pHei)} ${string(pkg?.dimension_unit, 'in')} ／ ${numberText(pWt)} ${string(pkg?.weight_unit, 'lb')}`
      : '未返回完整尺寸';
    const refRate = spApi.fee_calibration?.referral_fraction ?? (spApi.referral_terms?.type === 'flat' ? spApi.referral_terms.rate : null);
    const refStr = finite(refRate) ? `佣金比例 ${numberText(refRate * 100)}%` : '';
    const fbaLive = spApi.fee_calibration?.live_fba_fulfillment_usd ?? spApi.realtime_fba_fee_usd;
    const fbaStr = finite(fbaLive) ? `当天实时 FBA 基准 US$ ${numberText(fbaLive)}` : '';
    const restStatus = spApi.restrictions?.status ?? spApi.restriction_status;
    const restStr = restStatus ? `店铺限售状态：${string(restStatus)}` : '';
    const staleAudit = spApi.stale_sellersprite_audit;
    const staleStr = staleAudit?.stale_sellersprite_cache_corrected
      ? `已纠偏卖家精灵缓存旧尺寸（重量差 ${numberText(staleAudit.weight_delta_lb)} lb${finite(staleAudit.fba_2027_delta_usd) ? `，2027 FBA 差 US$ ${numberText(staleAudit.fba_2027_delta_usd)}` : ''}）`
      : (spApi.stale_dimension_alert && typeof spApi.stale_dimension_note === 'string' ? spApi.stale_dimension_note : '');
    rows.push({
      label: `SP-API 只读终审校参${spApi.asin ? `（${string(spApi.asin)}）` : ''}`,
      value: [pkgStr, refStr, fbaStr, restStr].filter(Boolean).join(' · '),
      note: staleStr,
    });
  }
  if (peerPkg && peerPkg.valid === true) {
    const mp = peerPkg.median_pkg;
    const mLen = mp?.length_in ?? mp?.length;
    const mWid = mp?.width_in ?? mp?.width;
    const mHei = mp?.height_in ?? mp?.height;
    const mWt = mp?.unit_weight_lb ?? mp?.weight;
    const mpStr = finite(mLen) && finite(mWid) && finite(mHei) && finite(mWt)
      ? `同款中位尺寸 ${numberText(mLen)} × ${numberText(mWid)} × ${numberText(mHei)} in ／ ${numberText(mWt)} lb（${numberText(peerPkg.peer_count ?? 0)} 款同款对标）`
      : '';
    const warnTag = peerPkg.supplier_borderline_alert && typeof peerPkg.sample_warning_tag === 'string'
      ? `【${peerPkg.sample_warning_tag}】`
      : '';
    rows.push({
      label: '同款中位包装锚定与压线核验',
      value: `${warnTag}${mpStr}`.trim(),
      note: typeof peerPkg.supplier_borderline_note === 'string' ? peerPkg.supplier_borderline_note : '',
    });
  }
  if (!rows.length) return '';
  return r57KeyValueSection('SP-API 官方尺寸与同款包装校参', rows);
}

function r58SeasonalCard(result, original, index, rev = 58, reportOptions = {}) {
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const displays = array(presentation.operating_periods);
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  const periods = array(result.operating_periods);
  const eligible = isCandidateEligible(result, rev);
  const snapshot = extractMetricsSnapshot(result, rev);
  const defaultPeriodIdx = Math.max(0, result.qualification?.display_period_id
    ? periods.findIndex(p => p?.id === result.qualification.display_period_id)
    : 0);

  const supplyTabIdx = periods.length + 1;
  const bibTabIdx = periods.length + 2;
  const idxPad = String(index + 1).padStart(2, '0');
  const hasBrief = array(presentation.risks).length || array(presentation.next_checks).length || blockers.length;
  const bucket = candidateFilterBucket(result, rev);
  const cardLabel = result.label ?? result.candidate_id;

  return `<article class="candidate" id="${prefix}" data-queue="seasonal_review" data-eligible="${eligible ? 'true' : 'false'}" data-bucket="${bucket}">
    <div class="split-stage">
      <div class="left-wing">
        <div class="title-line">
          <span class="ed-idx ed-idx-lg">${idxPad}</span>
          <h2>${escape(cardLabel)}</h2>
        </div>
        <div class="status-row">
          ${typeof presentation.subtitle_en === 'string' && presentation.subtitle_en.trim() ? `<span class="st-en">${escape(presentation.subtitle_en.trim())}</span><span class="pc-sep">·</span>` : ''}
          ${renderDotStatus(result, snapshot, rev)}
          <span class="pc-sep">·</span>
          <span class="muted queue-tag">分季评估</span>
        </div>
        ${typeof presentation.summary === 'string' ? `<p class="lead-copy">${escape(r58PolishRangeCopy(presentation.summary))}</p>` : ''}
        ${renderR58SculpturalLedger(snapshot, '待补证')}
        <p class="spec-copy">${escape(result.form ?? '具体可售规格尚待明确')}</p>
        ${starReferenceSection(original)}
        ${r59PriceBandBannersAndObservationBar(original, rev)}${r59SamplePendingBanner(snapshot, rev)}${hasBrief ? `<section class="quiet-surface brief-grid" aria-label="关键风险与核查清单">
          ${r57BriefList('风险与边界提示', presentation.risks, rev)}
          ${r57BriefList('后续核查事项', presentation.next_checks, rev)}
          ${blockers.length ? `<div class="brief-col"><h3>共同问题与后续处理</h3><ul class="brief-list">${blockers.map(row => `<li><strong>${escape(row.problem)}</strong>${typeof row.next_step === 'string' ? `<p class="muted">下一步：${escape(row.next_step)}</p>` : ''}</li>`).join('')}</ul></div>` : ''}
        </section>` : ''}${renderR58EvidenceReview(result, original, reportOptions, rev)}${r57ReviewNotes(result, original, rev)}${r57OperationalDisclosures(result, rev)}
      </div>
      <div class="stage-hairline" aria-hidden="true"></div>
      <div class="right-wing">
        <div class="card-tabs">
          <div class="segmented-track" role="radiogroup" aria-label="${escape(cardLabel)} 视图切换">
            ${periods.map((p, idx) => {
              const pDot = (p.queue === 'comparable' || (rev >= 59 && Array.isArray(p.sample_check_items) && p.sample_check_items.length > 0)) ? 'pass' : p.queue === 'excluded' ? 'fail' : 'pending';
              return `<label class="seg-btn" for="${prefix}-t${idx + 1}" title="${escape(p.label)}"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t${idx + 1}" ${idx === defaultPeriodIdx ? 'checked' : ''}><i class="dot dot-${pDot}" aria-hidden="true"></i>${escape(r58CompactTabLabel(p.label))}</label>`;
            }).join('')}
            <label class="seg-btn" for="${prefix}-t${supplyTabIdx}"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t${supplyTabIdx}">1688 货源与存证</label>
            <label class="seg-btn" for="${prefix}-t${bibTabIdx}"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t${bibTabIdx}">证据回执 · ${registry.length}</label>
          </div>
          <div class="tab-panels">
            ${periods.map((period, idx) => r58PeriodPanel(period, object(displays.find(display => display?.id === period.id)), registry, prefix, idx + 1, rev, original)).join('')}
            <section class="tab-panel tab-p${supplyTabIdx} tab-panel-supply">
              ${r58ContactSheetFigure(presentation, cardLabel, prefix)}
              ${r58ReferenceImageFigure(presentation, cardLabel, prefix)}
              ${r59CalibrationSummarySection(original, rev)}${r57KeyValueSection('采购参考与 1688 规格核对', presentation.procurement)}
              ${r57KeyValueSection('款式事实与共同依据', presentation.facts)}
              ${r57KeyValueSection('市场范围与补充观察', presentation.market_references)}
              ${r57DiscoveryDetails(original?.discovery, registry, prefix, rev)}
            </section>
            <section class="tab-panel tab-p${bibTabIdx} tab-panel-bib">
              <div class="section-head"><h3>来源与适用限制</h3><span class="muted">本地路径已统一脱敏</span></div>
              ${r57Bibliography(registry, prefix)}
            </section>
          </div>
        </div>${renderR58ConceptPlinth(result, original, cardLabel, prefix)}
      </div>
    </div>
  </article>`;
}

function r58SingleCard(result, original, index, rev = 58, reportOptions = {}) {
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  const gaps = array(result.items).filter(item => item.status === 'needs_evidence');
  const mainGaps = blockers.length ? blockers : gaps.slice(0, 3).map(item => ({ problem: `${ITEM_LABELS[item.id] ?? item.id}：${reasonText(item.reason)}`, next_step: '补齐对应来源和适用口径后重新计算。' }));
  const screenGaps = array(result.screening?.conditions).filter(condition => condition.status !== 'pass');
  const queue = Object.hasOwn(QUEUES, result.queue) ? result.queue : 'pending';
  const isCrossingR59 = rev >= 59 && result?.diagnostics?.economics?.crossing_margin_floor === true;
  const complete = Array.isArray(result.total_range) && (queue === 'comparable' || isCrossingR59);
  const incompleteLabel = queue === 'excluded' ? '当前规格已排除，不列完整总分' : queue === 'deferred' ? '本期暂缓，不列完整总分' : '完整总分待补证';
  const ineligible = array(result.items).filter(item => item.status === 'ineligible');
  const coverageText = ineligible.length
    ? `已计分权重 ${numberText(result.covered_weight)} / 100；不满足合格评分条件 ${ineligible.length} 项；待补证 ${gaps.length} 项。`
    : `证据覆盖权重 ${numberText(result.covered_weight)} / 100；未评分权重 ${numberText(result.unscored_weight)}。`;
  const eligible = isCandidateEligible(result, rev);
  const snapshot = extractMetricsSnapshot(result, rev);
  const hasSamplePendingSingleR59 = rev >= 59 && snapshot.sampleCheckItems.length > 0;
  const idxPad = String(index + 1).padStart(2, '0');
  const hasBrief = array(presentation.risks).length || array(presentation.next_checks).length || mainGaps.length;
  const qualReasonNote = !eligible && queue === 'pending' && array(result.qualification?.reasons).length
    ? `<p class="muted coverage-line">达标口径核验：${result.qualification.reasons.map(r => escape(sanitizeTextPaths(reasonText(r)))).join('；')}</p>`
    : '';
  const bucket = candidateFilterBucket(result, rev);
  const cardLabel = result.label ?? result.candidate_id;

  return `<article class="candidate" id="${prefix}" data-queue="${queue}" data-eligible="${eligible ? 'true' : 'false'}" data-bucket="${bucket}">
    <div class="split-stage">
      <div class="left-wing">
        <div class="title-line">
          <span class="ed-idx ed-idx-lg">${idxPad}</span>
          <h2>${escape(cardLabel)}</h2>
        </div>
        <div class="status-row">
          ${typeof presentation.subtitle_en === 'string' && presentation.subtitle_en.trim() ? `<span class="st-en">${escape(presentation.subtitle_en.trim())}</span><span class="pc-sep">·</span>` : ''}
          ${renderDotStatus(result, snapshot, rev)}
          <span class="pc-sep">·</span>
          <span class="muted queue-tag">${hasSamplePendingSingleR59 ? '入围（含拿样待核）' : QUEUES[queue]}</span>
        </div>
        ${typeof presentation.summary === 'string' ? `<p class="lead-copy">${escape(r58PolishRangeCopy(presentation.summary))}</p>` : ''}
        ${renderR58SculpturalLedger(snapshot, incompleteLabel)}
        <p class="spec-copy">${escape(result.form ?? '具体可售规格尚待明确')}</p>
        ${starReferenceSection(original)}
        <div class="inline-score-status">
          ${complete ? `<p>完整总分 <strong>${escape(rangeText(result.total_range))} / 100</strong></p>` : (hasSamplePendingSingleR59 ? `<p><strong>已得分 ${escape(rangeText(result.supported_range))} / 已覆盖总权重 ${escape(numberText(result.covered_weight))}</strong></p>` : `<p class="ink-muted"><strong>${escape(incompleteLabel)}</strong></p>`)}
          <p class="muted">已支持分数 ${escape(rangeText(result.supported_range))}；${escape(coverageText)}</p>
          ${result.conditional_total_range ? `<p class="muted">满足准入后可能范围 ${escape(rangeText(result.conditional_total_range))}。这是数学界限，不是已获得总分或预测。</p>` : ''}
          ${result.may_exceed_comparable_leader ? '<p class="ink-pass">有效可能上界高于当前完整队列首项的保守端点，值得补证；这不代表已经胜出。</p>' : ''}
        </div>
        ${r59PriceBandBannersAndObservationBar(original, rev)}${r59SamplePendingBanner(snapshot, rev)}${hasBrief ? `<section class="quiet-surface brief-grid" aria-label="关键风险与缺口">
          ${r57BriefList('风险与边界提示', presentation.risks, rev)}
          ${r57BriefList('后续核查事项', presentation.next_checks, rev)}
          ${mainGaps.length ? `<div class="brief-col"><h3>${queue === 'excluded' && gaps.length === 0 ? '排除原因与后续处理' : '需要解决的缺口'}</h3><ul class="brief-list">${mainGaps.map(row => `<li><strong>${escape(row.problem)}</strong>${typeof row.next_step === 'string' ? `<p class="muted">下一步：${escape(row.next_step)}</p>` : ''}</li>`).join('')}</ul></div>` : ''}
        </section>` : ''}${renderR58EvidenceReview(result, original, reportOptions, rev)}${r57ReviewNotes(result, original, rev)}${r57OperationalDisclosures(result, rev)}
        ${screenGaps.length ? `<p class="muted coverage-line">筛选状态：${screenGaps.map(condition => `${escape({ reference_price: '参考售价', margin: '毛利条件', specific_form_rights: '具体款式权利', strong_date_dependency: '日期依赖' }[condition.id] ?? condition.id)}${escape(STATES[condition.status] ?? condition.status)}：${escape(reasonText(condition.reason))}`).join('；')}</p>` : '<p class="muted coverage-line">初筛条件已得到有据判断；这不是采购批准或供应验证。</p>'}${qualReasonNote}
      </div>
      <div class="stage-hairline" aria-hidden="true"></div>
      <div class="right-wing">
        <div class="card-tabs">
          <div class="segmented-track" role="radiogroup" aria-label="${escape(cardLabel)} 视图切换">
            <label class="seg-btn" for="${prefix}-t1"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t1" checked>八维图谱与评分</label>
            <label class="seg-btn" for="${prefix}-t2"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t2">单件收支瀑布</label>
            <label class="seg-btn" for="${prefix}-t3"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t3">采购核对与存证</label>
            <label class="seg-btn" for="${prefix}-t4"><input class="tab-radio" type="radio" name="tabs-${prefix}" id="${prefix}-t4">证据回执 · ${registry.length}</label>
          </div>
          <div class="tab-panels">
            <section class="tab-panel tab-p1">
              ${buildR58PolarRose(result)}
              ${r59CompetitionReferenceBar(original, rev)}<section class="ledger-section">
                <div class="section-head"><h3>21 项评分明细</h3><span class="muted">8 大维度 · 点击编号直达原始证据</span></div>
                ${r57ScoreRows(result, registry, prefix, rev)}
              </section>
              ${r57NewcomerDetails(result, rev)}
            </section>
            <section class="tab-panel tab-p2">
              ${r57EconomicWaterfall(result, `${prefix}-econ-main`, rev, original)}
            </section>
            <section class="tab-panel tab-p3 tab-panel-supply">
              ${r58ContactSheetFigure(presentation, cardLabel, prefix)}
              ${r58ReferenceImageFigure(presentation, cardLabel, prefix)}
              ${r59CalibrationSummarySection(original, rev)}${r57KeyValueSection('采购参考与规格核对', presentation.procurement)}
              ${r57KeyValueSection('市场范围与新增观察', presentation.market_references)}
              ${r57DiscoveryDetails(original?.discovery, registry, prefix, rev)}
            </section>
            <section class="tab-panel tab-p4 tab-panel-bib">
              <div class="section-head"><h3>来源与适用限制</h3><span class="muted">本地路径已统一脱敏</span></div>
              ${r57Bibliography(registry, prefix)}
            </section>
          </div>
        </div>${renderR58ConceptPlinth(result, original, cardLabel, prefix)}
      </div>
    </div>
  </article>`;
}

const R58_STUDIO_CSS = `
:root{
  color-scheme:light;
  --ease:cubic-bezier(.22,1,.36,1);
  --sans:"Hanken Grotesk","Noto Sans SC","PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","Microsoft YaHei UI",sans-serif;
  --serif-it:"Newsreader",Georgia,serif;
  --canvas:#ffffff;
  --plinth:#f4f5f8;
  --quiet:rgba(9,9,11,.03);
  --ink:#09090b;
  --ink-2:#1c1d22;
  --muted:#383a42;
  --hairline:rgba(9,9,11,.13);
  --hairline-strong:rgba(9,9,11,.26);
  --vermilion:#c42b00;
  --forest:#036647;
  --amber:#8a4800;
  --dot-pass:#036647;
  --dot-warn:#8a4800;
  --dot-fail:#c42b00;
  --ink-pass:#036647;
  --ink-fail:#c42b00;
}
*{box-sizing:border-box}
html{
  scroll-behavior:smooth;
  scroll-padding-top:2.5rem;
  scrollbar-color:#6b6e78 transparent;
  accent-color:var(--vermilion);
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{
  margin:0;
  background:var(--canvas);
  color:var(--ink);
  font-family:var(--sans);
  font-weight:460;
  font-size:0.96875rem;
  line-height:1.74;
  overflow-wrap:anywhere;
}
::selection{background:rgba(196,43,0,.16);color:var(--ink)}
h1,h2,h3,h4,p,figure,dl,dd{margin:0}
h1,h2,th{text-wrap:balance}
p{text-wrap:pretty}
h1{
  font-size:clamp(2.05rem,1.5rem + 1.8vw,2.8rem);
  font-weight:580;
  letter-spacing:0.02em;
  line-height:1.18;
}
h2{
  font-size:clamp(1.7rem,1.3rem + 1.2vw,2.35rem);
  font-weight:560;
  letter-spacing:0.018em;
  line-height:1.24;
}
h3{
  font-size:1.25rem;
  font-weight:590;
  letter-spacing:0.012em;
  line-height:1.35;
}
h4{
  font-size:1.03125rem;
  font-weight:560;
  line-height:1.45;
}
.group-title{font-size:1rem;font-weight:600;color:var(--ink)}
.item-title{font-size:0.9375rem;font-weight:560;color:var(--ink)}
a{
  color:var(--ink);
  text-underline-offset:0.26em;
  text-decoration-color:var(--hairline-strong);
  text-decoration-thickness:1px;
}
a:hover{text-decoration-color:var(--vermilion)}
a:focus-visible,summary:focus-visible,.table-scroll:focus-visible,.tn-tab:has(:focus-visible),.seg-btn:has(:focus-visible){
  outline:2px solid var(--vermilion);
  outline-offset:3px;
}
.ico{display:inline-block;vertical-align:-0.12em;flex-shrink:0}
.sep-bar{display:inline-block;width:1px;height:0.65rem;background:var(--hairline-strong);margin-inline:0.45rem;vertical-align:-1px}
.num,.num-col,.side-ledger dd{
  font-family:"Hanken Grotesk",var(--sans);
  font-variant-numeric:tabular-nums;
  letter-spacing:-0.022em;
}
.ed-idx,.mono-idx{
  font-family:var(--serif-it);
  font-style:italic;
  font-weight:520;
  font-size:1.0625rem;
  letter-spacing:0;
  color:#2c2e36;
}
.ed-idx-lg{font-size:1.375rem;color:var(--vermilion);font-weight:540}
code,.mono-id,.mono-kw{
  font-family:"Hanken Grotesk",var(--sans);
  font-size:0.875rem;
}
.mono-id{color:var(--muted);font-weight:500}
.mono-kw{color:var(--ink);font-weight:580}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip-link{position:absolute;top:-6rem;left:1rem;background:var(--ink);color:#fff;padding:0.5rem 0.9rem;z-index:80;text-decoration:none;font-size:0.875rem}
.skip-link:focus{top:0.75rem}
.filter-radio,.tab-radio,.mode-check{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}

.studio-page{
  max-width:98.75rem;
  margin-inline:auto;
  padding:3.25rem 4.5vw 7rem;
}

/* Asymmetric Magazine Masthead */
.masthead{
  display:flex;
  justify-content:space-between;
  align-items:flex-end;
  gap:1.75rem 2.5rem;
  flex-wrap:wrap;
  padding-bottom:2.25rem;
  border-bottom:1px solid var(--hairline);
}
.mh-left{max-width:56rem}
.mh-colophon{
  margin-top:0.6rem;
  font-size:1rem;
  color:var(--ink-2);
  max-width:65ch;
}
.mh-en{
  font-family:var(--serif-it);
  font-style:italic;
  font-weight:500;
  font-size:1.0625rem;
  color:#272930;
  letter-spacing:0.005em;
}
.mh-sep{color:var(--muted);margin-inline:0.4rem}
.batch-counts{
  margin-top:0.55rem;
  color:var(--ink-2);
  font-size:0.9375rem;
  font-weight:460;
  line-height:1.72;
  max-width:68ch;
}
.mh-right{
  display:flex;
  flex-direction:column;
  align-items:flex-end;
  gap:0.75rem;
  max-width:100%;
}

/* Pure Unboxed Single-Row Scrollable Navigation & Tabs */
.typo-nav,.segmented-track{
  display:flex;
  align-items:baseline;
  gap:1.6rem;
  overflow-x:auto;
  max-inline-size:100%;
  scrollbar-width:none;
  scroll-snap-type:inline proximity;
  padding-bottom:0.35rem;
}
.typo-nav::-webkit-scrollbar,.segmented-track::-webkit-scrollbar{display:none}
.tn-tab,.seg-btn{
  position:relative;
  flex:none;
  scroll-snap-align:start;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  gap:0.4rem;
  min-block-size:2.1rem;
  padding:0.25rem 0 0.45rem;
  font-size:0.9375rem;
  font-weight:550;
  color:#2c2e36;
  text-decoration:none;
  user-select:none;
  transition:color .2s ease;
}
.tn-tab:hover,.seg-btn:hover{color:var(--ink)}
.tn-tab:has(:checked),.seg-btn:has(:checked){
  color:var(--ink);
}
.tn-tab:has(:checked)::after,.seg-btn:has(:checked)::after{
  content:"";
  position:absolute;
  inset:auto 0 0;
  border-block-end:2.5px solid var(--vermilion);
}
.queue-nav{
  display:flex;
  align-items:baseline;
  gap:1.1rem;
  flex-wrap:wrap;
  font-size:0.875rem;
  font-weight:520;
}
.queue-nav a{color:#25272e;text-decoration:underline;text-decoration-color:rgba(9,9,11,.36)}
.queue-nav a:hover{color:var(--ink);text-decoration-color:var(--vermilion)}

/* Staggered Art-Gallery Exhibition Plinth Reel */
.exhibition-reel{
  display:grid;
  grid-template-columns:repeat(var(--reel-cols,5),minmax(0,1fr));
  gap:1.75rem;
  align-items:start;
  padding:2.25rem 0 3.5rem;
  border-bottom:1px solid var(--hairline);
}
@media(hover:hover){
  .exhibition-reel:hover .plinth-item:not(:hover){opacity:.55}
  .plinth-item:hover{transform:translateY(-4px)}
  .plinth-item:hover .plinth-photo img{transform:scale(1.045)}
}
.plinth-item{
  display:flex;
  flex-direction:column;
  text-decoration:none;
  color:inherit;
  transition:opacity .35s ease,transform .35s var(--ease);
}
.plinth-item.is-stagger{margin-top:1.375rem}
.plinth-photo{
  position:relative;
  aspect-ratio:4/3;
  background:var(--plinth);
  overflow:hidden;
  border-radius:3px;
}
.plinth-photo img{
  display:block;
  width:100%;
  height:100%;
  object-fit:cover;
  transition:transform .55s var(--ease);
}
.plinth-photo-typo{
  display:grid;
  place-items:center;
  padding:1.25rem;
}
.plinth-specimen{text-align:center}
.ps-big{display:block;font-size:clamp(1.6rem,1.2rem + 1.2vw,2.35rem);font-weight:560;line-height:1.05}
.ps-sub{display:block;margin-top:0.4rem;font-size:0.875rem;font-weight:500;color:var(--muted)}
.plinth-caption{
  padding-top:1.375rem;
  position:relative;
}
.pc-row1{
  display:flex;
  align-items:baseline;
  gap:0.625rem;
}
.pc-title{
  font-size:1rem;
  font-weight:560;
  letter-spacing:0.012em;
  line-height:1.4;
  color:var(--ink);
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.pc-row2{
  margin-top:0.4rem;
  padding-inline-start:1.6875rem;
  display:flex;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.45rem;
  font-size:0.875rem;
  font-weight:500;
  color:#2c2e36;
}
.pc-sep{color:#6b6e78}
.pc-active-bar{
  display:block;
  margin-top:0.95rem;
  height:2.5px;
  width:0;
  background:var(--ink);
  transition:width .38s var(--ease);
}
.studio-page:not(:has(.candidate:target)) .exhibition-reel .plinth-item:first-child .ed-idx{color:var(--vermilion)}
.studio-page:not(:has(.candidate:target)) .exhibition-reel .plinth-item:first-child .pc-active-bar{width:100%}

/* Open Architectural Split Stage */
.candidate{
  padding-block:4rem;
  border-bottom:1px solid var(--hairline);
  scroll-margin-top:2rem;
}
.split-stage{
  display:grid;
  grid-template-columns:minmax(0,1.04fr) 1px minmax(0,1fr);
  gap:3.25rem;
  align-items:stretch;
}
.stage-hairline{background:var(--hairline)}
.left-wing{min-width:0}
@media(min-width:72rem){
  .left-wing{position:sticky;top:2rem;align-self:start}
}
.right-wing{min-width:0}
.title-line{
  display:flex;
  align-items:baseline;
  gap:0.75rem;
}
.title-line h2{flex:1;min-width:0}
.status-row{
  margin-top:0.6rem;
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  gap:0.5rem 0.65rem;
  font-size:0.90625rem;
  font-weight:500;
}
.st-en{
  font-family:var(--serif-it);
  font-style:italic;
  font-weight:500;
  font-size:1.03125rem;
  color:#272930;
  letter-spacing:0.005em;
}
.lead-copy{
  margin-top:1.1rem;
  font-size:1rem;
  font-weight:470;
  line-height:1.74;
  letter-spacing:0.012em;
  color:var(--ink);
  max-width:60ch;
}
.spec-copy{
  margin-top:0.55rem;
  font-size:0.90625rem;
  font-weight:460;
  line-height:1.68;
  color:var(--ink-2);
  max-width:62ch;
}
.star-ref{margin-top:0.5rem;font-size:0.90625rem;font-weight:460;color:var(--ink-2);max-width:62ch}

/* Dramatic Sculptural Margin Readout */
.sculptural-metrics{
  margin-top:1.5rem;
  padding:1.65rem 0;
  border-top:1px solid var(--hairline);
  border-bottom:1px solid var(--hairline);
}
.sm-primary-row{
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:1.25rem 1.75rem;
  flex-wrap:wrap;
}
.sm-label{
  display:block;
  font-size:0.875rem;
  font-weight:520;
  color:#2c2e36;
  margin-bottom:0.45rem;
}
.hero-stat-val{
  font-size:clamp(3.15rem,2rem + 3.2vw,5.2rem);
  font-weight:560;
  letter-spacing:-0.038em;
  line-height:0.96;
}
.hero-stat-val.is-range{
  font-size:clamp(2.25rem,1.5rem + 1.9vw,3.35rem);
  letter-spacing:-0.035em;
}
.sm-side-pair{
  display:flex;
  gap:1.65rem;
  flex-wrap:wrap;
}
.sm-side-item span{
  display:block;
  font-size:0.875rem;
  font-weight:520;
  color:#2c2e36;
  margin-bottom:0.25rem;
}
.sm-side-item strong{
  font-size:clamp(1.25rem,1.05rem + 0.5vw,1.6rem);
  font-weight:560;
  line-height:1.08;
}
.hero-stat-sub{
  margin-top:0.85rem;
  font-size:0.90625rem;
  font-weight:500;
  line-height:1.55;
}

.side-ledger{
  margin-top:0.2rem;
  margin-bottom:1rem;
  display:flex;
  flex-direction:column;
}
.side-ledger>div{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:1rem;
  padding:0.7rem 0;
  border-bottom:1px solid var(--hairline);
  font-size:0.90625rem;
}
.side-ledger dt{color:#2c2e36;font-weight:500;flex-shrink:0}
.side-ledger dd{text-align:right;color:var(--ink);font-weight:530}

.inline-score-status{
  margin-top:1.1rem;
  padding-block:0.75rem;
  border-bottom:1px solid var(--hairline);
  font-size:0.90625rem;
}
.quiet-surface{
  margin-top:1.35rem;
  padding-top:1.15rem;
  border-top:1px solid var(--hairline);
}
.brief-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));
  gap:1.25rem 1.75rem;
}
.brief-col h3{margin-bottom:0.5rem;color:var(--ink)}
.brief-list{padding-inline-start:1.15em;margin:0;font-size:0.90625rem;line-height:1.68;color:var(--ink-2)}
.brief-list li+li{margin-top:0.45rem}

/* Status Indicators (Zero Pill Boxes) */
.dot{
  width:0.4rem;
  height:0.4rem;
  border-radius:9999px;
  display:inline-block;
  flex-shrink:0;
  background:var(--muted);
}
.state-pass .dot,.dot-pass{background:var(--dot-pass)}
.state-pending .dot,.dot-pending,.dot-warn{background:var(--dot-warn)}
.state-fail .dot,.dot-fail{background:var(--dot-fail)}
.state-inline{
  display:inline-flex;
  align-items:center;
  gap:0.4rem;
  font-size:0.90625rem;
  font-weight:560;
  color:var(--ink);
}
.state-pass{color:var(--forest)}
.state-fail{color:var(--vermilion)}
.state-pending{color:var(--amber)}
.ink-pass{color:var(--ink-pass)}
.ink-fail{color:var(--ink-fail)}
.ink-muted,.muted{color:var(--muted)}

/* Right Wing Tabs & Nightingale Polar Rose */
.card-tabs .segmented-track{
  gap:1.2rem;
  border-bottom:1px solid var(--hairline);
  padding-bottom:0;
  margin-bottom:1.75rem;
}
.tab-panel{display:none}
.card-tabs:has(input[id$="-t1"]:checked) .tab-p1,
.card-tabs:has(input[id$="-t2"]:checked) .tab-p2,
.card-tabs:has(input[id$="-t3"]:checked) .tab-p3,
.card-tabs:has(input[id$="-t4"]:checked) .tab-p4,
.card-tabs:has(input[id$="-t5"]:checked) .tab-p5{
  display:block;
}
.card-tabs:has(.tab-panel-bib :target) .tab-panel-bib{
  display:block;
  margin-top:1.5rem;
  padding-top:1.5rem;
  border-top:1px solid var(--hairline-strong);
}
@supports not selector(:has(*)){
  .tab-panel{display:block;margin-top:1.5rem}
}

.polar-wrap{
  display:grid;
  grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);
  gap:1.5rem;
  align-items:center;
  padding-bottom:1.75rem;
  border-bottom:1px solid var(--hairline);
  margin-bottom:1.5rem;
}
.rose-svg{width:100%;max-width:22rem;height:auto;display:block;margin-inline:auto}
.rose-ring{fill:none;stroke:rgba(9,9,11,.11);stroke-width:1}
.rose-petal{
  fill:rgba(9,9,11,.16);
  stroke:#ffffff;
  stroke-width:1.5;
  transition:fill .24s ease;
}
.rose-sector:hover .rose-petal,.rose-sector.is-sel .rose-petal{fill:var(--ink)}
.rose-lbl{
  font-family:var(--sans);
  font-size:0.8125rem;
  font-weight:540;
  fill:#272930;
  transition:fill .2s ease;
}
.rose-sector:hover .rose-lbl,.rose-sector.is-sel .rose-lbl{fill:var(--ink);font-weight:680}
.pd-k{display:block;font-size:0.875rem;font-weight:520;color:#2c2e36}
.pd-big{font-size:clamp(2.05rem,1.65rem + 1.1vw,2.7rem);font-weight:560;line-height:1.08;margin-top:0.25rem}
.pd-big small{font-size:1.0625rem;color:var(--muted);font-weight:500}
.polar-group-summary{
  margin-top:1rem;
  padding-top:0.8rem;
  border-top:1px solid var(--hairline);
  display:grid;
  grid-template-columns:1fr;
  gap:0.32rem;
  font-size:0.875rem;
  font-weight:500;
}
.pgs-row{display:flex;justify-content:space-between;gap:0.75rem;color:#272930;white-space:nowrap}
.pgs-row.is-sel{color:var(--ink);font-weight:640}

.period-meta-line{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.65rem 1.5rem;
  padding-bottom:0.85rem;
  border-bottom:1px solid var(--hairline);
}
.period-note{margin-top:0.3rem;font-size:0.90625rem;color:var(--ink-2);max-width:62ch}
.period-inline-nums{display:flex;gap:1rem;flex-wrap:wrap;font-size:0.90625rem;color:var(--ink-2)}
.period-inline-nums strong{color:var(--ink)}
.coverage-line{margin-top:0.55rem;font-size:0.90625rem;color:var(--ink-2);max-width:65ch}

/* Tables, Waterfalls, Score Rows & Disclosures */
.ledger-section{margin-top:2rem}
.ledger-section>h3{margin-bottom:0.65rem}
.section-head{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.4rem 1rem;
  margin-bottom:0.65rem;
}
.section-lead{margin-bottom:0.4rem;max-width:65ch}

.alloc-strip{
  margin:0.5rem 0 1.25rem;
  padding:0.9rem 0;
  border-top:1px solid var(--hairline);
  border-bottom:1px solid var(--hairline);
}
.alloc-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:0.4rem 1rem;font-size:0.875rem;margin-bottom:0.55rem}
.alloc-track{position:relative;display:flex;height:0.4rem;background:rgba(9,9,11,.08);overflow:hidden}
.alloc-seg{height:100%;display:block}
.alloc-supply{background:#18181b}
.alloc-platform{background:#71717a}
.alloc-margin-pass{background:var(--forest)}
.alloc-margin-fail{background:var(--vermilion)}
.alloc-tick{position:absolute;top:0;bottom:0;left:70%;width:1.5px;background:var(--canvas);box-shadow:0 0 0 .75px var(--ink)}
.alloc-legend{display:flex;flex-wrap:wrap;gap:0.5rem 1.25rem;margin-top:0.6rem;font-size:0.875rem;color:var(--ink-2)}
.alloc-legend span{display:inline-flex;align-items:center;gap:0.4rem}
.swatch{width:0.45rem;height:0.45rem;display:inline-block;flex-shrink:0}
.swatch-supply{background:#18181b}
.swatch-platform{background:#71717a}
.swatch-pass{background:var(--forest)}
.swatch-fail{background:var(--vermilion)}

.table-scroll{
  overflow:auto;
  max-inline-size:100%;
  container-type:inline-size;
  scrollbar-color:#6b6e78 transparent;
}
.hairline-table{
  width:100%;
  border-collapse:separate;
  border-spacing:0;
  font-size:0.90625rem;
}
.hairline-table th,.hairline-table td{
  padding:0.7rem 0.85rem;
  text-align:left;
  border-bottom:1px solid var(--hairline);
  vertical-align:middle;
}
.hairline-table th:first-child,.hairline-table td:first-child{padding-inline-start:0}
.hairline-table th:last-child,.hairline-table td:last-child{padding-inline-end:0}
.hairline-table thead th{
  position:sticky;
  inset-block-start:0;
  z-index:2;
  background:var(--canvas);
  color:#2c2e36;
  font-weight:560;
  border-bottom:1px solid var(--hairline-strong);
  white-space:nowrap;
}
.hairline-table .num-col{text-align:right;white-space:nowrap}
.hairline-table tbody th{
  position:sticky;
  inset-inline-start:0;
  z-index:1;
  background:var(--canvas);
  font-weight:540;
  color:var(--ink);
}
.hairline-table tbody tr:hover th,.hairline-table tbody tr:hover td{background:#f8f9fb}
.th-note{display:block;font-size:0.84375rem;font-weight:460;color:var(--muted)}
.waterfall-table .row-dim th,.waterfall-table .row-dim td{color:var(--muted)}
.waterfall-table .row-sum th,.waterfall-table .row-sum td{border-top:1px solid var(--hairline-strong)}

.scenario-folds{margin-top:0.5rem}
.quiet-fold{border-bottom:1px solid var(--hairline)}
summary{
  list-style:none;
  cursor:pointer;
  display:flex;
  align-items:center;
  gap:0.5rem;
  min-block-size:2.4rem;
  padding:0.6rem 0;
  font-size:0.90625rem;
  font-weight:560;
  color:var(--ink);
}
summary::-webkit-details-marker{display:none}
summary::before{
  content:"";
  width:0.35rem;
  height:0.35rem;
  border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor;
  transform:rotate(-45deg);
  flex-shrink:0;
}
details[open]>summary::before{transform:rotate(45deg)}
@media(prefers-reduced-motion:no-preference){
  summary::before{transition:transform .16s ease}
  details::details-content{
    interpolate-size:allow-keywords;
    overflow:clip;
    contain:layout;
    transition:block-size .2s ease,content-visibility .2s ease;
    transition-behavior:allow-discrete;
  }
  details:not([open])::details-content{block-size:0}
}
summary:hover{color:var(--vermilion)}
.fold-body{padding:0.25rem 0 1rem 0.95rem;font-size:0.90625rem;color:var(--ink-2)}
.fold-body h3{margin:0.75rem 0 0.4rem}
.fold-body ul{padding-inline-start:1.2em;margin:0.4rem 0}
.fold-body li+li{margin-top:0.35rem}

.score-columns{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));
  gap:1.5rem 2.25rem;
}
.score-group{border-top:1px solid var(--hairline-strong);padding-top:0.65rem}
.group-bar{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:0.75rem;
  padding-bottom:0.5rem;
  border-bottom:1px solid var(--hairline);
}
.group-pts{font-size:0.875rem;font-weight:550;color:var(--ink-2)}
.item-row{padding:0.8rem 0;border-bottom:1px solid var(--hairline);font-size:0.90625rem}
.item-heading{display:flex;justify-content:space-between;align-items:baseline;gap:0.75rem;margin-bottom:0.25rem}
.item-score{font-weight:580;flex-shrink:0}
.item-input{color:var(--ink-2)}
.item-reason{margin-top:0.2rem;color:var(--ink)}
.item-row>.source{margin-top:0.3rem}
.item-qualifier{display:none}
.studio-page:has(#expand-qualifiers:checked) .item-qualifier{display:block}
.cite-fold{border:0;margin-top:0.15rem}
.cite-fold>summary{min-block-size:1.6rem;padding:0.15rem 0;color:var(--muted);font-size:0.84375rem}

.bid-block{margin-top:0.65rem;padding-top:0.65rem;border-top:1px solid var(--hairline)}
.bid-summary-line{margin-bottom:0.25rem}
.bid-rows{margin-top:0.5rem;border-top:1px solid var(--hairline)}
.bid-row{padding:0.65rem 0}
.bid-row+.bid-row{border-top:1px solid var(--hairline)}
.bid-row-head{display:flex;justify-content:space-between;align-items:baseline;gap:0.65rem;flex-wrap:wrap}
.bid-row-meta{font-size:0.875rem;color:var(--ink-2)}
.bid-sub{margin-top:0.15rem}

.kv-rows{border-top:1px solid var(--hairline)}
.kv-row{
  display:grid;
  grid-template-columns:12rem minmax(0,1fr);
  gap:1rem;
  padding:0.75rem 0;
  border-bottom:1px solid var(--hairline);
  font-size:0.90625rem;
}
.kv-row dt{color:#2c2e36;font-weight:540}
.kv-main{color:var(--ink);font-weight:540}
.pill-link{
  display:inline-flex;
  align-items:center;
  gap:0.25rem;
  margin-inline-start:0.45rem;
  color:var(--ink);
  text-decoration:underline;
  text-decoration-color:var(--vermilion);
  text-underline-offset:0.24em;
  font-size:0.875rem;
  font-weight:550;
}

/* Contact Sheet & Pure-CSS :target Lightbox */
.contact-sheet-frame{margin:0.5rem 0 0}
.zoom-trigger{display:block;text-decoration:none;cursor:zoom-in;background:var(--plinth);border-radius:4px;overflow:hidden}
.contact-sheet-frame img{display:block;width:100%;max-height:32rem;object-fit:contain;margin-inline:auto}
.contact-sheet-frame figcaption{
  margin-top:0.75rem;
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:1rem;
  flex-wrap:wrap;
  font-size:0.875rem;
  color:var(--ink-2);
}
.zoom-hint{color:var(--ink);font-weight:550;text-decoration:underline;text-decoration-color:var(--vermilion);flex-shrink:0}
.css-lightbox{display:none;position:fixed;inset:0;z-index:120;place-items:center;padding:2vw}
.css-lightbox:target{display:grid}
.lb-backdrop{position:absolute;inset:0;background:rgba(9,9,11,.78);cursor:zoom-out}
.lb-sheet{
  position:relative;
  z-index:1;
  width:min(94vw,82rem);
  max-height:92vh;
  overflow:auto;
  background:var(--canvas);
  padding:1.5rem 2rem;
  border-radius:6px;
  box-shadow:0 24px 64px rgba(0,0,0,.28);
}
.lb-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding-bottom:0.9rem;border-bottom:1px solid var(--hairline);margin-bottom:1.1rem}
.lb-close{color:var(--vermilion);font-weight:560;text-decoration:underline}
.lb-sheet img{display:block;width:100%;max-height:78vh;object-fit:contain}

.lead-list,.bibliography{padding-inline-start:1.35em;margin:0.5rem 0;font-size:0.90625rem}
.lead-list li+li{margin-top:0.55rem}
.bibliography li{padding:0.65rem 0.4rem;border-bottom:1px solid var(--hairline);scroll-margin-top:4rem}
.bibliography li:target{background:var(--plinth)}
.bib-head{display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem 1rem;flex-wrap:wrap}
.bib-meta{color:var(--muted);font-size:0.84375rem}

.source{font-size:0.84375rem;line-height:1.6;color:var(--muted)}
p+p{margin-top:0.35rem}

/* Comparison Matrix Ledger & Footer */
.matrix-block{margin-top:4rem;padding-top:2.5rem;border-top:1px solid var(--hairline)}
.row-jump{text-decoration:underline;text-decoration-color:var(--hairline-strong);font-weight:550}
.row-jump .mono-idx{margin-inline-end:0.45rem}
.matrix-check{color:var(--ink-2);max-width:28ch}
.method-section{margin-top:2.75rem}
.empty-state{padding:3rem 0;border-top:1px solid var(--hairline)}
.filter-empty{display:none;padding:2.5rem 0;border-bottom:1px solid var(--hairline);font-size:0.96875rem}
.report-footer{
  margin-top:2.5rem;
  padding-top:1.5rem;
  border-top:1px solid var(--hairline);
  font-size:0.875rem;
  color:var(--ink-2);
  display:flex;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:0.5rem 1.5rem;
}

@media (forced-colors:active){
  .tn-tab:has(:checked)::after,.seg-btn:has(:checked)::after{border-block-end-color:Highlight}
  .pc-active-bar{background:Highlight}
  .stage-hairline{background:CanvasText}
}

/* Pure-CSS Filter Rules */
.studio-page:has(#filter-pass:checked) :is(.plinth-item,.candidate,.matrix-table tbody tr):not([data-eligible="true"]),
.studio-page:has(#filter-pending:checked) :is(.plinth-item,.candidate,.matrix-table tbody tr):not([data-bucket="pending"]),
.studio-page:has(#filter-hold:checked) :is(.plinth-item,.candidate,.matrix-table tbody tr):not([data-bucket="hold"]){
  display:none;
}
.studio-page:has(#filter-pass:checked):not(:has(.candidate[data-eligible="true"])) .filter-empty,
.studio-page:has(#filter-pending:checked):not(:has(.candidate[data-bucket="pending"])) .filter-empty,
.studio-page:has(#filter-hold:checked):not(:has(.candidate[data-bucket="hold"])) .filter-empty{
  display:block;
}
.studio-page:has(#filter-pass:checked):not(:has(.candidate[data-eligible="true"])) :is(.exhibition-reel,.matrix-block),
.studio-page:has(#filter-pending:checked):not(:has(.candidate[data-bucket="pending"])) :is(.exhibition-reel,.matrix-block),
.studio-page:has(#filter-hold:checked):not(:has(.candidate[data-bucket="hold"])) :is(.exhibition-reel,.matrix-block){
  display:none;
}

@container (width < 42.5rem){
  .matrix-table,.matrix-table thead,.matrix-table tbody,.matrix-table tr,.matrix-table th,.matrix-table td{display:block}
  .matrix-table thead{display:none}
  .matrix-table tr{padding:.85rem 0;border-bottom:1px solid var(--hairline-strong)}
  .matrix-table tbody th{position:static;padding:0 0 .4rem;border-bottom:0}
  .matrix-table td,.matrix-table .num-col{border-bottom:0;padding:.28rem 0;display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;text-align:right;white-space:normal}
  .matrix-table td::before{flex-shrink:0;white-space:nowrap;color:var(--muted)}
  .matrix-table td.matrix-check{flex-direction:column;align-items:flex-start;text-align:left;gap:.15rem;max-width:none}
  .matrix-table{
    --m2:"结论";--m3:"美站参照价";--m4:"1688百套含运";--m5:"广告前毛利";
    --m6:"扣15%广告后";--m7:"单件贡献";--m8:"21项总分";--m9:"采购前头号核查";
  }
  .matrix-table td:nth-child(2)::before{content:var(--m2)}
  .matrix-table td:nth-child(3)::before{content:var(--m3)}
  .matrix-table td:nth-child(4)::before{content:var(--m4)}
  .matrix-table td:nth-child(5)::before{content:var(--m5)}
  .matrix-table td:nth-child(6)::before{content:var(--m6)}
  .matrix-table td:nth-child(7)::before{content:var(--m7)}
  .matrix-table td:nth-child(8)::before{content:var(--m8)}
  .matrix-table td:nth-child(9)::before{content:var(--m9)}
}

@media(max-width:72rem){
  .exhibition-reel{grid-template-columns:repeat(2,minmax(0,1fr))}
  .plinth-item.is-stagger{margin-top:0}
  .split-stage{grid-template-columns:1fr;gap:2.25rem}
  .stage-hairline{height:1px;width:100%}
  .mh-right{align-items:flex-start}
}
@media(max-width:45rem){
  .studio-page{padding:2rem 1.25rem 4.5rem}
  .polar-wrap{grid-template-columns:1fr}
  .polar-group-summary{grid-template-columns:1fr}
  .kv-row{grid-template-columns:1fr;gap:.2rem}
  .waterfall-table th:first-child{max-width:9rem;white-space:normal}
}
@media(max-width:30rem){
  .exhibition-reel{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
@media print{
  body{background:#fff;color:#000;font-size:9.5pt}
  .studio-page{padding:0}
  .typo-nav,.queue-nav,.segmented-track,.exhibition-reel,.skip-link{display:none!important}
  .split-stage{display:block}
  .stage-hairline{display:none}
  .tab-panel{display:block!important;padding-top:10pt}
  details::details-content{display:block;content-visibility:visible}
  details>*{display:block!important}
  .item-qualifier{display:block!important}
}
`;

const R58_AI_SECTIONS_CSS = `
.inline-score-status{padding:0.75rem 0}
.state-muted{color:#383a42}
.state-muted .dot{background:#383a42}
.rt-audit .rt-head{margin-bottom:0.35rem}
.rt-meta-row{
  display:flex;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.45rem 0.65rem;
  font-size:0.90625rem;
  color:#1c1d22;
}
.rt-reviewer{color:#0f0f12;font-weight:560}
.rt-dispositions{
  margin-top:0.75rem;
  padding:0.75rem 0;
  border-top:1px solid var(--hairline);
  border-bottom:1px solid var(--hairline);
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.4rem 1rem;
  font-size:0.875rem;
}
.rt-disp-label{color:#383a42;font-weight:540}
.rt-disp-stats{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:0.45rem;color:#1c1d22;font-weight:520}
.rt-conclusion{
  margin-top:0.75rem;
  font-size:0.9375rem;
  line-height:1.72;
  color:#0f0f12;
  max-width:64ch;
}
.rt-subblock{margin-top:0.85rem}
.rt-subheading{
  display:block;
  font-size:0.90625rem;
  font-weight:580;
  color:#0f0f12;
  margin-bottom:0.35rem;
}
.rt-list{padding-inline-start:1.15em;margin:0;font-size:0.90625rem;line-height:1.68;color:#1c1d22}
.rt-list li+li{margin-top:0.4rem}
.rt-conflict-id{
  color:var(--vermilion);
  font-weight:580;
  text-decoration:underline;
  text-decoration-color:rgba(196,43,0,.38);
  text-underline-offset:0.22em;
}
.rt-item-lead{color:#0f0f12;font-weight:560}
.concept-plinth-section{
  margin-top:2.25rem;
  padding-top:1.5rem;
  border-top:1px solid var(--hairline);
}
.concept-plinth-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(min(100%,15.5rem),1fr));
  gap:1.5rem;
  margin-top:0.85rem;
}
.concept-plinth-card{margin:0;display:flex;flex-direction:column}
.concept-plinth-stage{
  aspect-ratio:4/3;
  display:grid;
  place-items:center;
  padding:0.75rem;
  background:var(--plinth);
  border-radius:3px;
  overflow:hidden;
}
.concept-plinth-stage img{
  display:block;
  width:100%;
  height:100%;
  object-fit:contain;
  transition:transform .45s var(--ease);
}
@media(hover:hover){
  .concept-plinth-stage:hover img{transform:scale(1.035)}
}
.concept-plinth-meta{padding-top:0.85rem}
.cp-title-row{display:flex;align-items:baseline;gap:0.55rem;flex-wrap:wrap}
.cp-title{flex:1;min-width:8rem;font-size:0.9375rem;font-weight:560;color:#0f0f12}
.cp-caption{margin-top:0.3rem;font-size:0.875rem;line-height:1.62;color:#383a42;max-width:60ch}
.lb-caption{margin-top:0.85rem;font-size:0.875rem;line-height:1.6;color:#383a42}
@media print{
  .css-lightbox{display:none!important}
}
`;

function renderR58Report(result, batch = {}, reportOptions = {}) {
  const rev = result?.profile_revision ?? 58;
  const rawPresentation = { ...object(batch?.presentation), discovery_summary: batch?.discovery_summary };
  const presentation = sanitizeDisplayTree(rawPresentation);
  const rawCandidates = array(result?.candidates);
  const candidates = rawCandidates.map(c => {
    if (!c || typeof c !== 'object') return sanitizeDisplayTree(c);
    if (!Array.isArray(c.concept_images)) return sanitizeDisplayTree(c);
    const { concept_images: rawConcept, ...rest } = c;
    return {
      ...sanitizeDisplayTree(rest),
      concept_images: sanitizeR58ConceptImages(rawConcept),
    };
  });
  const originals = new Map(array(batch?.candidates).map(candidate => {
    if (!candidate || typeof candidate !== 'object') return [candidate?.id, candidate];
    const rawConcept = Array.isArray(candidate.concept_images)
      ? candidate.concept_images
      : Array.isArray(candidate.presentation?.concept_images)
        ? candidate.presentation.concept_images
        : undefined;
    const presWithoutConcept = candidate.presentation && typeof candidate.presentation === 'object' && !Array.isArray(candidate.presentation) && Array.isArray(candidate.presentation.concept_images)
      ? (() => { const { concept_images: _ignored, ...rest } = candidate.presentation; return rest; })()
      : candidate.presentation;
    return [
      candidate.id,
      {
        ...candidate,
        presentation: sanitizeDisplayTree(presWithoutConcept, '', true),
        discovery: sanitizeDisplayTree(candidate.discovery),
        market: sanitizeDisplayTree(candidate.market),
        ...(candidate.evidence_review !== undefined ? { evidence_review: sanitizeDisplayTree(candidate.evidence_review) } : {}),
        ...(rawConcept !== undefined ? { concept_images: sanitizeR58ConceptImages(rawConcept) } : {}),
      },
    ];
  }));
  const title = string(presentation.title, '美国站选品视觉策展室');
  const eligibleCount = candidates.filter(cand => isCandidateEligible(cand, rev)).length;
  const holdCount = candidates.filter(cand => candidateFilterBucket(cand, rev) === 'hold').length;
  const pendingBucketCount = candidates.filter(cand => candidateFilterBucket(cand, rev) === 'pending').length;
  const reservedBucketCount = rev >= 59 ? candidates.filter(cand => candidateFilterBucket(cand, rev) === 'reserved').length : 0;
  const completeCount = candidates.filter(cand => cand?.queue === 'comparable' && isCandidateEligible(cand, rev)).length;
  const pendingCount = candidates.filter(cand => cand?.queue === 'pending' && candidateFilterBucket(cand, rev) === 'pending').length;
  const seasonalReviewCount = candidates.filter(cand => cand?.queue === 'seasonal_review').length;
  const seasonalEligibleCount = candidates.filter(cand => cand?.queue === 'seasonal_review' && isCandidateEligible(cand, rev)).length;
  const seasonalInPendingBucket = candidates.filter(cand => cand?.queue === 'seasonal_review' && candidateFilterBucket(cand, rev) === 'pending').length;
  const seasonalInHoldBucket = candidates.filter(cand => cand?.queue === 'seasonal_review' && candidateFilterBucket(cand, rev) === 'hold').length;
  const crossingInPendingCount = rev >= 59
    ? candidates.filter(cand => candidateFilterBucket(cand, rev) === 'pending' && cand?.effective_disposition === 'crossing_30pct_interval').length
    : 0;

  const r59CrossingSuffix = crossingInPendingCount > 0
    ? `（其中跨 30% 区间可推进 ${escape(numberText(crossingInPendingCount))} 个）`
    : '';
  const r59ReservedSuffix = reservedBucketCount > 0
    ? `，私模留档 ${escape(numberText(reservedBucketCount))} 个`
    : '';
  const headlineHoldSuffix = holdCount > 0
    ? `，淘汰／暂缓 ${escape(numberText(holdCount))} 个${seasonalInHoldBucket ? `（含分季排除／暂缓 ${escape(numberText(seasonalInHoldBucket))} 个）` : ''}`
    : '';
  const headlinePendingText = `待补证 ${escape(numberText(pendingBucketCount))} 个${seasonalInPendingBucket ? `（含分季待补 ${escape(numberText(seasonalInPendingBucket))} 个）` : ''}${r59CrossingSuffix}${r59ReservedSuffix}${headlineHoldSuffix}`;
  const usesOct14OffPeakR59 = rev >= 59 && candidates.some(cand =>
    cand?.queue === 'seasonal_review' && array(cand.operating_periods).some(p =>
      (Array.isArray(p?.months) && p.months.length === 9 && [2, 3, 4, 5, 6, 7, 8, 9, 10].every(m => p.months.includes(m))) ||
      array(p?.diagnostics?.economics?.scenarios).some(s => s?.input?.cost_ledger?.fee_context?.sales?.through === '2027-10-14'),
    ),
  );
  const seasonalCounts = seasonalReviewCount
    ? (usesOct14OffPeakR59
      ? `分季评估 ${escape(numberText(seasonalReviewCount))} 个款式，其中 2027-02-01 至 2027-10-14 主营淡季初评达标 ${escape(numberText(seasonalEligibleCount))} 个款式（非强节日依赖且覆盖完整 2027-02-01 至 2027-10-14 淡季窗口；2027 旺季毛利率待亚马逊公布 2027 旺季费率后补充）；各经营季节由主人选择。`
      : `分季评估 ${escape(numberText(seasonalReviewCount))} 个款式，其中 2027 年 2–9 月主营淡季初评达标 ${escape(numberText(seasonalEligibleCount))} 个款式（非强节日依赖且覆盖完整 2027-02-01 至 2027-09-30 淡季窗口）；各经营季节由主人选择。`)
    : '';
  const r58OrderRule = usesOct14OffPeakR59
    ? '全年 12 个月完整可比卡优先列于 2027-02-01 至 2027-10-14 主营淡季达标卡之前；区间重叠不代表严格优劣。'
    : '全年 12 个月完整可比卡优先列于 2–9 月主营淡季达标卡之前；区间重叠不代表严格优劣。';

  const queueLinks = [
    (() => {
      const idx = candidates.findIndex(c => c?.queue === 'comparable' && isCandidateEligible(c, rev));
      return idx >= 0 ? `<a href="#candidate-${idx + 1}">完整可比 ${escape(numberText(completeCount))}</a>` : '';
    })(),
    (() => {
      const idx = candidates.findIndex(c => c?.queue === 'seasonal_review' && isCandidateEligible(c, rev));
      return idx >= 0 ? `<a href="#candidate-${idx + 1}">分季达标 ${escape(numberText(seasonalEligibleCount))}</a>` : '';
    })(),
    (() => {
      const idx = candidates.findIndex(c => c?.queue === 'pending' && candidateFilterBucket(c, rev) === 'pending');
      return idx >= 0 ? `<a href="#candidate-${idx + 1}">待补证 ${escape(numberText(pendingCount))}</a>` : '';
    })(),
    (() => {
      const idx = candidates.findIndex(c => c?.queue === 'seasonal_review' && candidateFilterBucket(c, rev) === 'pending');
      return idx >= 0 ? `<a href="#candidate-${idx + 1}">分季待补 ${escape(numberText(seasonalInPendingBucket))}</a>` : '';
    })(),
    (() => {
      const idx = reservedBucketCount > 0 ? candidates.findIndex(c => candidateFilterBucket(c, rev) === 'reserved') : -1;
      return idx >= 0 ? `<a href="#candidate-${idx + 1}">私模留档 ${escape(numberText(reservedBucketCount))}</a>` : '';
    })(),
    (() => {
      const idx = candidates.findIndex(c => candidateFilterBucket(c, rev) === 'hold');
      return idx >= 0 && holdCount > 0 ? `<a href="#candidate-${idx + 1}">淘汰／暂缓 ${escape(numberText(holdCount))}</a>` : '';
    })(),
  ].join('');

  const maxPanels = Math.max(12, ...candidates.map(c => (c?.queue === 'seasonal_review' ? array(c.operating_periods).length + 2 : 4)));
  const anyOver100Report = candidates.some(cand => {
    const s = extractMetricsSnapshot(cand, rev);
    return s.orderUnitsRange && s.orderUnitsRange[1] > 100;
  });
  const anyAiSections = candidates.some(cand => {
    const orig = originals.get(cand?.candidate_id);
    return resolveR58EvidenceReview(cand, orig) !== null ||
      (sanitizeR58ConceptImages(resolveR58ConceptImages(cand, orig))?.length ?? 0) > 0;
  });
  const targetPlinthCss = candidates.length
    ? candidates.map((_, idx) => `.studio-page:has(#candidate-${idx + 1}:target) .exhibition-reel .plinth-item[href="#candidate-${idx + 1}"] .ed-idx{color:var(--vermilion)}\n.studio-page:has(#candidate-${idx + 1}:target) .exhibition-reel .plinth-item[href="#candidate-${idx + 1}"] .pc-active-bar{width:100%}`).join('\n')
    : '';
  const reservedFilterCss = reservedBucketCount > 0
    ? [
        '.studio-page:has(#filter-reserved:checked) .exhibition-reel .plinth-item:not([data-bucket="reserved"]),',
        '.studio-page:has(#filter-reserved:checked) .candidate:not([data-bucket="reserved"]),',
        '.studio-page:has(#filter-reserved:checked) .matrix-table tbody tr:not([data-bucket="reserved"]){display:none}',
        '.studio-page:has(#filter-reserved:checked):not(:has(.candidate[data-bucket="reserved"])) .filter-empty{display:block}',
        '.studio-page:has(#filter-reserved:checked):not(:has(.candidate[data-bucket="reserved"])) .exhibition-reel,',
        '.studio-page:has(#filter-reserved:checked):not(:has(.candidate[data-bucket="reserved"])) .matrix-block{display:none}',
      ].join('\n')
    : '';
  const dynamicCss = [
    `${Array.from({ length: maxPanels - 5 }, (_, idx) => `.card-tabs:has(input[id$="-t${idx + 6}"]:checked) .tab-p${idx + 6}`).join(',\n')}{\n  display:block;\n}`,
    targetPlinthCss,
    reservedFilterCss,
    anyOver100Report ? '@container (width < 42.5rem){.matrix-table{--m4:"1688到深含运"}}' : '',
    anyAiSections ? R58_AI_SECTIONS_CSS.trim() : '',
  ].filter(Boolean).join('\n');

  const reservedTabHtml = reservedBucketCount > 0
    ? `<label class="tn-tab" for="filter-reserved"><input class="filter-radio" type="radio" name="wb-filter" id="filter-reserved">私模留档 ${escape(numberText(reservedBucketCount))}</label>`
    : '';
  const filterNavHtml = `<label class="tn-tab" for="filter-all"><input class="filter-radio" type="radio" name="wb-filter" id="filter-all" checked>全部 ${escape(numberText(candidates.length))}</label><label class="tn-tab" for="filter-pass"><input class="filter-radio" type="radio" name="wb-filter" id="filter-pass">达标可推进 ${escape(numberText(eligibleCount))}</label><label class="tn-tab" for="filter-pending"><input class="filter-radio" type="radio" name="wb-filter" id="filter-pending">待补证 ${escape(numberText(pendingBucketCount))}</label>${reservedTabHtml}<label class="tn-tab" for="filter-hold"><input class="filter-radio" type="radio" name="wb-filter" id="filter-hold">淘汰／暂缓 ${escape(numberText(holdCount))}</label><a class="tn-tab" href="#overview">横向比对</a><label class="tn-tab" for="expand-qualifiers"><input class="mode-check" type="checkbox" id="expand-qualifiers">口径说明</label>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="text-scale" content="scale"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>${R58_FONT_FACE_CSS}${R58_STUDIO_CSS}\n${dynamicCss}</style></head><body><a class="skip-link" href="#cards">跳到候选卡</a><main class="studio-page"><header class="masthead"><div class="mh-left"><h1>${escape(title)}</h1><p class="mh-colophon"><span class="mh-en">US FBA Product Curation · 2027 Fee Architecture · Rev ${escape(result?.profile_revision ?? 58)}</span>${typeof presentation.summary === 'string' ? `<span class="mh-sep">／</span><span>${escape(presentation.summary)}</span>` : ''}</p><p class="batch-counts">本轮 ${escape(numberText(candidates.length))} 个候选；完整可比 ${escape(numberText(completeCount))} 个，${headlinePendingText}。${seasonalCounts}${r58OrderRule}</p></div>${candidates.length ? `<div class="mh-right" role="region" aria-label="筛选与视图控制"><div class="typo-nav" role="radiogroup" aria-label="候选筛选">${filterNavHtml}</div>${queueLinks ? `<nav class="queue-nav" aria-label="跳转候选队列">${queueLinks}</nav>` : ''}</div>` : ''}</header>${renderR58ExhibitionReel(candidates, originals, rev)}<p class="filter-empty muted">当前筛选条件下暂无候选款式，请切换至“全部”查看完整展列。</p><section id="cards" aria-label="候选产品深度精算展台">${candidates.length ? candidates.map((candidate, index) => (candidate?.queue === 'seasonal_review' ? r58SeasonalCard(object(candidate), originals.get(candidate?.candidate_id), index, rev, reportOptions) : r58SingleCard(object(candidate), originals.get(candidate?.candidate_id), index, rev, reportOptions))).join('') : '<div class="empty-state"><h2>本轮没有候选卡</h2><p class="muted">保留发现与覆盖记录；没有候选不等于市场中没有机会。</p></div>'}</section>${renderComparisonMatrix(candidates, originals, rev)}${r57NegotiationAppendix(result, batch, rev)}${r59PackagingRedesignAppendix(result, batch, rev)}${r57BatchContext(presentation)}<footer class="report-footer"><p>评分反映本轮证据与已确认试评规则。未知不按零计，不把已知部分折算为100分；初步评分、供应验证、主人决定与实际经营效果分别核验。</p><p>规则版本：修订 ${escape(result?.profile_revision ?? '未知')} · 离线单文件零外部请求</p></footer></main></body></html>`;
}

export function renderReport(result, batch = {}, reportOptions = {}) {
  if (isR58(result)) return renderR58Report(result, batch, reportOptions);
  return isR57(result) ? renderR57Report(result, batch) : renderLegacyReport(result, batch);
}
