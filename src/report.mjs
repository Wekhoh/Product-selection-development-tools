// Self-contained, script-free Chinese Curatorial Studio (01 视觉策展室) report renderer (Revision 59+).
import { BARE_GOODS_DISCLOSURE_ZH } from './business-thresholds.mjs';
import { redactRawEmails, sanitizeDiagnosticText } from './contracts.mjs';
import { ledgerMeetsMarginFloor } from './economics.mjs';
import {
  evaluateSingleFactoryCompleteKit,
  INCOMPLETE_CROSS_FACTORY_KIT_NOTE_ZH,
} from './fba-calculator.mjs';
import { extractNewcomerReviewOriginBreakdown } from './observations.mjs';
import { R58_FONT_FACE_CSS } from './report-fonts.mjs';
import { R58_STUDIO_CSS, R58_AI_SECTIONS_CSS } from './report-studio-css.mjs';
import { verifySavedCodexReceipt } from './receipt-verifier.mjs';
import { isUsableActivePricingScenario, resolveScenarioComparabilityLinkage } from './scoring.mjs';

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
const STATES = { pass: '通过此项', fail: '不满足', pending: '待补证', defer: '本期暂缓', crossing_pass: '区间跨线待核' };
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
const escape = value => {
  const raw = safeText(value);
  const clean = raw && !/^data:image\/(?:png|jpeg|webp);base64,/i.test(raw)
    ? scrubShareableText(raw, false)
    : raw;
  return clean.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
};
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
  const winUserRoot = String.raw`(?:(?:\\\\|\/\/)\?[\\/]UNC[\\/]+[^\\/\s:;\r\n"|?*<>]+[\\/]+(?:[^\\/\s:;\r\n"|?*<>]+[\\/]+)?|(?:(?:\\\\|\/\/)[?.][\\/]+)?[A-Za-z]:[\\/]+|(?<!https?:)(?:\\\\|\/\/)[^\\/\s:;\r\n"|?*<>]+[\\/]+(?:[^\\/\s:;\r\n"|?*<>]+[\\/]+)?)`;
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

const isActivePricingScenario = sc =>
  sc?.excluded_from_active_pricing !== true && sc?.comparability_linkage?.status !== 'confirmed_excluded';

const isScoredSupportedR58 = sc => isActivePricingScenario(sc) &&
  sc?.coherence_supported === true &&
  sc?.input?.calculation?.scoring_supported === true &&
  sc?.input?.calculation?.status !== 'sensitivity_only';

function effectiveScenarioLinkage(sc, original = null, periodId = null) {
  if (original && typeof original === 'object') {
    const resolved = resolveScenarioComparabilityLinkage(sc?.input ?? sc, original, {
      includeAdvisoryReview: true,
      periodId,
    });
    if (resolved && resolved.status && resolved.status !== 'undisputed') return resolved;
    return resolved ?? null;
  }
  const existing = sc?.comparability_linkage && typeof sc.comparability_linkage === 'object'
    ? sc.comparability_linkage
    : null;
  return existing;
}

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

const LEGACY_INQUIRY_CHANNEL_RE = /\u65fa\u65fa/g;
function unifyFactoryInquiryLabel(val) {
  if (typeof val !== 'string' || !val) return val;
  return val.replace(LEGACY_INQUIRY_CHANNEL_RE, '1688 问厂');
}

function scrubShareableText(val, trimResult = true) {
  const raw = typeof val === 'string' ? (trimResult ? val.trim() : val) : '';
  if (!raw) return '';
  const pathStripped = sanitizeTextPaths(raw)
    .replace(/(?:(?<![A-Za-z0-9_])[A-Za-z]:\\|\\\\[^\\/\s]+\\[^\\/\s]+\\)[^\s"'<>；;，,）)\]。]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/(?<![A-Za-z0-9_])[A-Za-z]:\/[^\s"'<>；;，,）)\]。]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/(?<![A-Za-z0-9_-])\.local[\\/][^\s"'<>；;，,）)\]。]+/gi, '[REDACTED_LOCAL_PATH]')
    .replace(/(?<!\d)(?:\+?1[-.\s]?)?(?:\([2-9]\d{2}\)[-.\s]?|[2-9]\d{2}[-.\s])\d{3}[-.\s]\d{4}(?!\d)/g, '[REDACTED_PHONE]');
  return r58CleanCopy(redactShareableReviewTree(pathStripped));
}

function parseJpegExifOrientation(bytes, segStart, segLen) {
  const payloadStart = segStart + 2;
  const payloadLen = segLen - 2;
  if (payloadLen < 6 || bytes.subarray(payloadStart, payloadStart + 6).toString('ascii') !== 'Exif\0\0') {
    return { kind: 'not_exif' };
  }
  const tiffStart = payloadStart + 6;
  const tiffEnd = payloadStart + payloadLen;
  if (tiffStart + 8 > tiffEnd) return { kind: 'malformed' };
  const le = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
  const be = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
  if (!le && !be) return { kind: 'malformed' };
  const readU16 = off => (le ? bytes.readUInt16LE(off) : bytes.readUInt16BE(off));
  const readU32 = off => (le ? bytes.readUInt32LE(off) : bytes.readUInt32BE(off));
  if (readU16(tiffStart + 2) !== 42) return { kind: 'malformed' };
  const ifd0Offset = readU32(tiffStart + 4);
  const ifd0Pos = tiffStart + ifd0Offset;
  if (ifd0Offset < 8 || ifd0Pos + 2 > tiffEnd) return { kind: 'malformed' };
  const entryCount = readU16(ifd0Pos);
  if (ifd0Pos + 2 + entryCount * 12 > tiffEnd) return { kind: 'malformed' };
  for (let k = 0; k < entryCount; k += 1) {
    const entryPos = ifd0Pos + 2 + k * 12;
    if (readU16(entryPos) === 0x0112) {
      const type = readU16(entryPos + 2);
      const count = readU32(entryPos + 4);
      if (type !== 3 || count !== 1) return { kind: 'malformed' };
      const orientation = readU16(entryPos + 8);
      if (orientation < 1 || orientation > 8) return { kind: 'malformed' };
      return { kind: 'ok', orientation };
    }
  }
  return { kind: 'ok', orientation: 1 };
}

function parseRasterDimensions(subtype, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) return null;
  if (subtype === 'png') {
    if (bytes.length < 24 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width >= 1 && height >= 1 ? { width, height } : null;
  }
  if (subtype === 'jpeg') {
    let i = 2;
    let sofDims = null;
    let exifOrientation = 1;
    let seenExif = false;
    while (i + 1 < bytes.length) {
      if (bytes[i] !== 0xff) break;
      while (i < bytes.length && bytes[i] === 0xff) i += 1;
      if (i >= bytes.length) break;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda) break;
      if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue;
      if (i + 2 > bytes.length) break;
      const segLen = bytes.readUInt16BE(i);
      if (segLen < 2 || i + segLen > bytes.length) break;
      if (marker === 0xe1 && !seenExif) {
        const exif = parseJpegExifOrientation(bytes, i, segLen);
        if (exif.kind === 'malformed') return null;
        if (exif.kind === 'ok') {
          exifOrientation = exif.orientation;
          seenExif = true;
        }
      } else if (!sofDims && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && segLen >= 7) {
        const height = bytes.readUInt16BE(i + 3);
        const width = bytes.readUInt16BE(i + 5);
        if (width >= 1 && height >= 1) sofDims = { width, height };
      }
      i += segLen;
    }
    if (!sofDims) return null;
    return exifOrientation >= 5 && exifOrientation <= 8
      ? { width: sofDims.height, height: sofDims.width }
      : sofDims;
  }
  if (subtype === 'webp') {
    if (bytes.length < 25) return null;
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && bytes.length >= 30) {
      if ((bytes[20] & 0x08) !== 0) return null;
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return width >= 1 && height >= 1 ? { width, height } : null;
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return width >= 1 && height >= 1 ? { width, height } : null;
    }
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      return width >= 1 && height >= 1 ? { width, height } : null;
    }
  }
  return null;
}

const REPORT_IMAGE_DEDUP_CSS = [
  '.img-defs-sprite{position:absolute;width:0;height:0;overflow:hidden;pointer-events:none}',
  '.plinth-photo svg.dedup-img{display:block;width:100%;height:100%;transition:transform .55s var(--ease)}',
  '@media(hover:hover){.plinth-item:hover .plinth-photo svg.dedup-img{transform:scale(1.045)}}',
  '.contact-sheet-frame svg.dedup-img{display:block;width:100%;height:auto;max-height:32rem;margin-inline:auto}',
  '.lb-sheet svg.dedup-img{display:block;width:100%;height:auto;max-height:78vh;margin-inline:auto}',
  '.concept-plinth-stage svg.dedup-img{display:block;width:100%;height:100%;transition:transform .45s var(--ease)}',
  '@media(hover:hover){.concept-plinth-stage:hover svg.dedup-img{transform:scale(1.035)}}',
].join('\n');
const REPORT_IMAGE_DEDUP_FIXED_OVERHEAD = Buffer.byteLength(REPORT_IMAGE_DEDUP_CSS, 'utf8') + 100;

function parseValidatedImage(value) {
  if (typeof value !== 'string' || value.length > 12_000_000) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) return null;
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) return null;
  return { uri: value, dims: parseRasterDimensions(match[1], bytes) };
}

function imageUri(value) {
  return parseValidatedImage(value)?.uri ?? null;
}

function createReportImagePool(candidates, originals) {
  const entries = new Map();
  const countRef = (rawUri, times = 1) => {
    if (typeof rawUri !== 'string' || times <= 0) return;
    const existing = entries.get(rawUri);
    if (existing) {
      existing.count += times;
      return;
    }
    const parsed = parseValidatedImage(rawUri);
    if (!parsed) return;
    entries.set(parsed.uri, { uri: parsed.uri, dims: parsed.dims, count: times });
  };

  for (const cand of candidates) {
    const orig = originals.get(cand?.candidate_id);
    const pres = object(orig?.presentation);
    const plinthUri = imageUri(pres.hero_image_data_uri) ?? imageUri(pres.image_data_uri) ?? imageUri(pres.contact_sheet_data_uri);
    if (plinthUri) countRef(plinthUri, 1);
  }
  for (const cand of candidates) {
    const orig = originals.get(cand?.candidate_id);
    const pres = object(orig?.presentation);
    if (pres.contact_sheet_data_uri) countRef(pres.contact_sheet_data_uri, 2);
    if (pres.image_data_uri) countRef(pres.image_data_uri, 2);
    const concepts = sanitizeR58ConceptImages(resolveR58ConceptImages(cand, orig)) ?? [];
    for (const item of concepts) {
      if (item?.data_uri) countRef(item.data_uri, 2);
    }
  }

  const dedupedAssets = [];
  const assetByUri = new Map();
  const profitableCandidates = [];
  let totalNetSaving = 0;
  for (const entry of entries.values()) {
    if (entry.count >= 2 && entry.dims) {
      const netSaving = (entry.count - 1) * entry.uri.length - (72 + entry.count * 125);
      if (netSaving > 0) {
        profitableCandidates.push(entry);
        totalNetSaving += netSaving;
      }
    }
  }
  // Hoist repeated images into a single inline SVG <defs><image> only when total savings strictly beat one-time sprite + CSS overhead.
  if (totalNetSaving > REPORT_IMAGE_DEDUP_FIXED_OVERHEAD) {
    for (const entry of profitableCandidates) {
      const id = `img-asset-${dedupedAssets.length + 1}`;
      const asset = { id, uri: entry.uri, width: entry.dims.width, height: entry.dims.height };
      dedupedAssets.push(asset);
      assetByUri.set(entry.uri, asset);
    }
  }

  return {
    renderImage(uri, { alt = '', mode = 'contain', width = null, height = null, lazy = true } = {}) {
      const asset = assetByUri.get(uri);
      if (asset) {
        const arMode = mode === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
        const wAttr = finite(width) ? width : asset.width;
        const hAttr = finite(height) ? height : asset.height;
        return `<svg class="dedup-img" viewBox="0 0 ${asset.width} ${asset.height}" width="${wAttr}" height="${hAttr}" preserveAspectRatio="${arMode}" role="img" aria-label="${escape(alt)}"><use href="#${asset.id}"/></svg>`;
      }
      const dimAttrs = finite(width) && finite(height) ? ` width="${width}" height="${height}"` : '';
      const lazyAttr = lazy ? ' loading="lazy"' : '';
      return `<img src="${escape(uri)}" alt="${escape(alt)}"${dimAttrs}${lazyAttr} decoding="async">`;
    },
    defsSpriteHtml() {
      if (!dedupedAssets.length) return '';
      return `<svg class="img-defs-sprite" width="0" height="0" aria-hidden="true"><defs>${dedupedAssets.map(a => `<image id="${a.id}" width="${a.width}" height="${a.height}" href="${escape(a.uri)}"/>`).join('')}</defs></svg>`;
    },
    dedupCss() {
      return dedupedAssets.length ? REPORT_IMAGE_DEDUP_CSS : '';
    },
  };
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
  incomplete_cross_factory_kit: INCOMPLETE_CROSS_FACTORY_KIT_NOTE_ZH,
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
    return '同任务满30天正常新品强制纳入，未满30天有销新品按精确有理数贪心择优并入使 F(S)=sum(e)/max(|S|,2) 严格提高；具体样本见下方。';
  }
  if (item.id === 'natural_visibility_development') {
    return '固定使用少评价销售表现选定的同一组样本 S* 与同一分母 D，采用 SIF 近30天整体自然曝光占比，不因数据易得而换例。';
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

function resolvePrimarySeasonalPeriodR58(candidate, rev = candidate?.profile_revision ?? 59) {
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

function isPrivateMoldReservedR59(candidate) {
  return candidate?.effective_disposition === 'private_mold_reserved' ||
    candidate?.qualification?.mode === 'private_mold_reserved';
}

function candidateFilterBucket(candidate, rev = candidate?.profile_revision ?? 59) {
  if (isPrivateMoldReservedR59(candidate)) return 'reserved';
  if (isCandidateEligible(candidate)) return 'eligible';
  if (candidate?.queue === 'excluded' || candidate?.queue === 'deferred') return 'hold';
  if (candidate?.queue === 'seasonal_review') {
    const prim = resolvePrimarySeasonalPeriodR58(candidate, rev);
    if (prim?.queue === 'excluded' || prim?.queue === 'deferred') return 'hold';
  }
  return 'pending';
}

function isCandidateEligible(candidate) {
  return candidate?.qualification?.counts_toward_target === true;
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

function showsBareGoodsCost(ledger) {
  const domLine = array(ledger?.lines).find(l => l?.id === 'domestic_freight');
  return Boolean(ledger?.cost_basis === 'bare_goods_1688' ||
    domLine?.bare_goods_screening === true ||
    (domLine?.status === 'not_applicable' && domLine?.amount_usd === 0));
}

function extractMetricsSnapshot(candidate, rev = candidate?.profile_revision ?? 59, original = null) {
  const target = candidate?.queue === 'seasonal_review'
    ? ((candidate?.qualification?.display_period_id
      ? array(candidate.operating_periods).find(p => p?.id === candidate.qualification.display_period_id)
      : null) ?? array(candidate.operating_periods)[0] ?? candidate)
    : candidate;
  const allScenarios = array(target?.diagnostics?.economics?.scenarios);
  const scenarios = allScenarios.filter(isActivePricingScenario);
  const scoredLedgers = scenarios
    .filter(isScoredSupportedR58)
    .map(s => s?.input?.calculation)
    .filter(c => c && c.status !== 'sensitivity_only');
  const activeLedgers = scoredLedgers;
  const isSensitivity = false;

  const validatedRefPrice = (() => {
    const rp = array(target?.screening?.conditions).find(c => c?.id === 'reference_price' && c?.status === 'pass');
    if (Array.isArray(rp?.effective_price_range) && rp.effective_price_range.length === 2 && rp.effective_price_range.every(finite)) {
      return rp.effective_price_range;
    }
    return finite(rp?.input?.value) ? [rp.input.value, rp.input.value] : null;
  })();
  const bareGoodsBounds = Array.isArray(target?.diagnostics?.economics?.bare_goods_margin_upper_bounds) &&
    target.diagnostics.economics.bare_goods_margin_upper_bounds.length === 2
    ? target.diagnostics.economics.bare_goods_margin_upper_bounds
    : null;
  const nonSensCoherentCalcs = scenarios
    .filter(s => s?.input?.coherent === true && !(s?.input?.cost_ledger?.sensitivity_only === true))
    .map(s => s?.input?.calculation)
    .filter(Boolean);
  const hasPendingComparability = scenarios.some(s => s?.comparability_linkage?.status === 'pending_evidence');
  const hasUnresolvedComparability =
    !Array.isArray(target?.diagnostics?.economics?.margin_range) &&
    ((allScenarios.length > 0 && scenarios.length === 0) || hasPendingComparability);
  const prices = hasUnresolvedComparability
    ? null
    : (minMaxRange(activeLedgers.map(c => c?.price_usd)) ??
      (bareGoodsBounds ? minMaxRange(nonSensCoherentCalcs.map(c => c?.price_usd)) : null) ??
      validatedRefPrice);
  const isBareGoodsCalc = calc => calc?.bare_goods_screening === true || showsBareGoodsCost(calc);
  const bareGoodsBasisPool = activeLedgers.length > 0
    ? activeLedgers
    : (nonSensCoherentCalcs.length > 0
      ? nonSensCoherentCalcs
      : (scenarios.length > 0 ? scenarios : allScenarios)
        .filter(s => !(s?.input?.cost_ledger?.sensitivity_only === true))
        .map(s => s?.input?.calculation ?? s?.input?.cost_ledger)
        .filter(Boolean));
  const isBareGoods = bareGoodsBasisPool.length > 0 && bareGoodsBasisPool.every(isBareGoodsCalc);
  const domesticDelivered = minMaxRange(activeLedgers.map(c => {
    const proc = array(c?.lines).find(l => l.id === 'procurement')?.amount_usd;
    const dom = array(c?.lines).find(l => l.id === 'domestic_freight')?.amount_usd;
    return finite(proc) && finite(dom) ? proc + dom : null;
  }));
  let marginFloorStatus = 'unknown';
  const hasUnresolvedPrimaryScenario =
    Boolean(target?.diagnostics?.economics?.expected_structural_error) ||
    (allScenarios.length > 0 && scenarios.length === 0) ||
    scenarios.some(s => !(s?.input?.cost_ledger?.sensitivity_only === true) && !isScoredSupportedR58(s));
  const marginScreenStatus = array(target?.screening?.conditions).find(c => c?.id === 'margin')?.status ?? null;
  const margins = Array.isArray(target?.diagnostics?.economics?.margin_range) && target.diagnostics.economics.margin_range.length === 2
    ? target.diagnostics.economics.margin_range
    : (hasUnresolvedPrimaryScenario
      ? bareGoodsBounds
      : (minMaxRange(activeLedgers.map(c => c?.margin)) ?? bareGoodsBounds));
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
  const adMargins = hasUnresolvedComparability ? null : minMaxRange(activeLedgers.map(c => c?.advertising_scenario_margin));
  const eligibleScenarios = scenarios.filter(isScoredSupportedR58);
  const contributions = hasUnresolvedComparability
    ? null
    : minMaxRange(
      eligibleScenarios.map(s => s?.contribution?.value).filter(finite).length
        ? eligibleScenarios.map(s => s?.contribution?.value)
        : activeLedgers.map(c => c?.contribution_usd),
    );
  const cnyTotals = minMaxRange(activeLedgers.map(c => {
    const si = sInputs(scenarios, c);
    if (isBareGoodsCalc(c) && finite(si?.procurement_cny)) return si.procurement_cny;
    return finite(si?.procurement_cny) && finite(si?.domestic_per_unit_cny) ? si.procurement_cny + si.domestic_per_unit_cny : null;
  }));
  const orderUnitsRange = minMaxRange(activeLedgers.map(c => {
    const si = sInputs(scenarios, c);
    const procLine = array(c?.lines).find(l => l.id === 'procurement');
    const domLine = array(c?.lines).find(l => l.id === 'domestic_freight');
    const u = procLine?.order_units ?? domLine?.order_units ?? si?.order_units ?? si?.complete_saleable_sets ?? null;
    return finite(u) && u > 0 ? u : null;
  }));
  const capCandidateScenarios = activeLedgers.length
    ? scenarios.filter(s => activeLedgers.includes(s?.input?.calculation))
    : scenarios.filter(s => {
      const cl = s?.input?.cost_ledger;
      const c = s?.input?.calculation;
      if (!c || cl?.sensitivity_only === true || cl?.sensitivity_only === 'true') return false;
      if (s?.input?.coherent === false) return false;
      if (validatedRefPrice && finite(c.price_usd) && c.price_usd > validatedRefPrice[1] + 1e-6) return false;
      return true;
    });
  const landedCapUsd = hasUnresolvedComparability ? null : minMaxRange(capCandidateScenarios.map(s => s?.input?.calculation?.landed_domestic_cap_at_30pct_usd));
  const landedCapCny = hasUnresolvedComparability ? null : minMaxRange(capCandidateScenarios.map(s => {
    const c = s?.input?.calculation;
    if (finite(c?.landed_domestic_cap_at_30pct_cny)) return c.landed_domestic_cap_at_30pct_cny;
    const si = s?.input?.cost_ledger?.source_inputs;
    const fx = finite(si?.fx_cny_per_usd) ? si.fx_cny_per_usd : si?.fx_usdcny;
    return finite(c?.landed_domestic_cap_at_30pct_usd) && finite(fx) && fx > 0
      ? c.landed_domestic_cap_at_30pct_usd * fx
      : null;
  }));
  const targetGoodsCnyAt30Pct = minMaxRange(capCandidateScenarios.map(s => {
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
  }));
  const stressMargins = minMaxRange(
    array(target?.diagnostics?.economics?.stress_scenarios)
      .filter(st => st?.excluded_from_active_pricing !== true)
      .map(st => st?.margin),
  );
  const complete = Array.isArray(target?.total_range) && (
    target?.queue === 'comparable' ||
    target?.diagnostics?.economics?.crossing_margin_floor === true
  );
  let crossingPassSummary = null;
  let crossingBelowSummary = null;
  if (target?.diagnostics?.economics?.crossing_margin_floor === true) {
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
  const targetPeriodId = candidate?.queue === 'seasonal_review'
    ? (target?.id ?? null)
    : (typeof target?.diagnostics?.economics?.operating_period_id === 'string' && target.diagnostics.economics.operating_period_id.trim()
      ? target.diagnostics.economics.operating_period_id.trim()
      : null);
  const scenarioLinkages = allScenarios.map(s => effectiveScenarioLinkage(s, original, targetPeriodId)).filter(Boolean);
  const aiDisputeCount = scenarioLinkages.filter(l => l.needs_ruling === true).length;
  const excludedPeerCount = scenarioLinkages.filter(l => l.status === 'confirmed_excluded').length;
  const pendingPeerCount = scenarioLinkages.filter(l => l.status === 'pending_evidence').length;
  const sampleCheckItems = array(target?.sample_check_items ?? candidate?.sample_check_items ?? candidate?.qualification?.sample_check_items);
  const core85Range = Array.isArray(target?.core_85_range) ? target.core_85_range : (Array.isArray(candidate?.core_85_range) ? candidate.core_85_range : null);
  const confirmedRiskDeduction15 = finite(target?.confirmed_risk_deduction_15)
    ? target.confirmed_risk_deduction_15
    : (finite(candidate?.confirmed_risk_deduction_15) ? candidate.confirmed_risk_deduction_15 : null);
  const remaining15Summary = target?.remaining_15_summary ?? candidate?.remaining_15_summary ?? null;
  const productSeasonality = string(candidate?.product_seasonality ?? candidate?.qualification?.product_seasonality).trim() || null;
  const unpublished2027Q4PeakNote = string(candidate?.unpublished_2027_q4_peak_note ?? candidate?.qualification?.unpublished_2027_q4_peak_note).trim() || null;
  return {
    target,
    prices,
    isBareGoods,
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
    core85Range,
    confirmedRiskDeduction15,
    remaining15Summary,
    productSeasonality,
    unpublished2027Q4PeakNote,
    aiDisputeCount,
    excludedPeerCount,
    pendingPeerCount,
    periodLabel: candidate?.queue === 'seasonal_review'
      ? string(target?.label, '主营时段')
      : (unpublished2027Q4PeakNote ? '2027 淡季常青窗口' : '全时段'),
  };
}

function statusDotInfo(candidate, snapshot, rev = candidate?.profile_revision ?? 0) {
  if (isPrivateMoldReservedR59(candidate, rev)) {
    return { tone: 'pending', text: '疑似私模／需开模留档' };
  }
  const eligible = isCandidateEligible(candidate, rev);
  if (eligible) {
    const hasUnpublishedQ4 = rev >= 59 && Boolean(
      snapshot?.unpublished2027Q4PeakNote ||
      (candidate.queue === 'seasonal_review' && array(candidate.operating_periods).some(
        p => typeof p?.unpublished_peak_note === 'string' && p.unpublished_peak_note.trim(),
      )),
    );
    if (rev >= 59 && snapshot?.sampleCheckItems?.length > 0) {
      if (hasUnpublishedQ4) {
        return {
          tone: 'pass',
          text: '非旺季达标 · 2027 Q4 旺季费率待公布（含拿样待核项）',
        };
      }
      return {
        tone: 'pass',
        text: candidate.queue === 'seasonal_review' ? '淡季入围 · 含拿样待核项' : '入围可推进 · 含拿样待核项',
      };
    }
    if (hasUnpublishedQ4) {
      return {
        tone: 'pass',
        text: '非旺季达标 · 2027 Q4 旺季费率待公布',
      };
    }
    return {
      tone: 'pass',
      text: candidate.queue === 'seasonal_review' ? '淡季达标 · 可推进' : '完整达标 · 可推进',
    };
  }
  if (candidate.queue === 'excluded') return { tone: 'fail', text: '不满足条件 · 排除' };
  if (candidate.queue === 'deferred') return { tone: 'pending', text: '强节日款 · 暂缓' };
  if (candidate.queue === 'seasonal_review') {
    const prim = resolvePrimarySeasonalPeriodR58(candidate);
    if (prim?.queue === 'excluded') return { tone: 'fail', text: '主营淡季不满足 · 排除' };
    if (prim?.queue === 'deferred') return { tone: 'pending', text: '主营淡季暂缓' };
  }
  if (rev >= 59 && (candidate?.effective_disposition === 'crossing_30pct_interval' || snapshot?.target?.diagnostics?.economics?.crossing_margin_floor === true)) {
    return {
      tone: 'pending',
      text: snapshot?.complete ? '跨 30% 红线 · 区间可比' : '跨 30% 红线 · 待核',
    };
  }
  if (snapshot.isSensitivity && snapshot.margins && snapshot.marginFloorStatus === 'fail') {
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
  const sep = '·';
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
  const cleanChannel = rev >= 59 ? unifyFactoryInquiryLabel : v => v;
  return `<div class="brief-col"><h3>${escape(title)}</h3><ul class="brief-list">${items.map(item => {
    if (typeof item === 'string') return `<li>${formatCleanBullet(cleanChannel(item), rev)}</li>`;
    const head = cleanChannel(string(item.label || item.problem, '提示'));
    const detail = item.value !== undefined ? `：${escape(readable(item.value))}${typeof item.unit === 'string' ? ` ${escape(item.unit)}` : ''}` : '';
    const note = cleanChannel(string(item.note || item.next_step));
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
  const pairKeys = new Set(pair.map(entry => `${entry.family_id}\0${entry.asin}`));
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
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const SAFE_ASIN_RE = /^[A-Za-z0-9_-]{4,24}$/;
    const formatKeepaAnomalyEvent = ev => {
      const rawFrom = string(ev?.date_from).trim();
      const rawTo = string(ev?.date_to ?? ev?.at).trim();
      const dFrom = ISO_DATE_RE.test(rawFrom) ? rawFrom : scrubShareableText(rawFrom);
      const dTo = ISO_DATE_RE.test(rawTo) ? rawTo : scrubShareableText(rawTo);
      const dateStr = dFrom && dTo && dFrom !== dTo
        ? `${dFrom}→${dTo}`
        : (dTo || dFrom || '日期未返回');
      const dirWord = ev?.direction === 'drop' || (finite(ev?.delta) && ev.delta < 0) ? '骤降' : '跃升';
      const deltaStr = finite(ev?.delta) ? (ev.delta > 0 ? `+${numberText(ev.delta)}` : numberText(ev.delta)) : '';
      const countStr = finite(ev?.from_count) && finite(ev?.to_count)
        ? `（${numberText(ev.from_count)} → ${numberText(ev.to_count)}）`
        : '';
      return `${dateStr} ${dirWord}${deltaStr ? ` ${deltaStr}` : ''}${countStr}`;
    };
    const renderKeepaAdvisoryText = adv => {
      const evList = array(adv?.events);
      const rawAsin = string(adv?.asin).trim();
      const safeAsin = SAFE_ASIN_RE.test(rawAsin) ? rawAsin : scrubShareableText(rawAsin);
      const rawParent = string(adv?.parent_asin).trim();
      const safeParent = SAFE_ASIN_RE.test(rawParent) ? rawParent : '';
      const idParts = [
        safeAsin,
        safeParent ? `父体 ${safeParent}` : '',
        finite(adv?.age_days) ? `上架 ${numberText(adv.age_days)} 天` : '',
      ].filter(Boolean).join(' · ');
      const textOut = evList.length > 0
        ? `${idParts ? `${idParts}：` : ''}${evList.map(formatKeepaAnomalyEvent).join('；')}（非阻断 · 零扣分，交由主人结合变体与类目节奏判断）`
        : (adv?.note_zh || '存在 Keepa 评论变动提示（非阻断 · 零扣分）。');
      return scrubShareableText(textOut);
    };
    const reviewAnomalies = rev >= 59 ? array(diagnostics.review_anomaly_advisories) : [];
    const anomalyByAsin = new Map(reviewAnomalies.filter(a => string(a?.asin).trim()).map(a => [string(a.asin).trim().toUpperCase(), a]));
    const keepaAnomalySummaryHtml = reviewAnomalies.length
      ? `<div class="quiet-surface" data-section="keepa-review-anomalies"><p class="muted"><strong>Keepa 评论变动提示（非阻断 · 零扣分）：</strong></p><ul class="brief-list">${reviewAnomalies.map(adv => `<li>${escape(renderKeepaAdvisoryText(adv))}</li>`).join('')}</ul></div>`
      : '';
    const rampNote = (rampExcl.length || rampZero.length)
      ? `<p class="muted">${rampExcl.length ? `未并入的未满30天有销新品（${rampExcl.length} 款，避免稀释 F(S)）：${rampExcl.map(r => `${escape(r.family_id)}（${escape(numberText(r.age_days))}天，e=${escape(numberText(r.score))}）`).join('；')}。` : ''}${rampZero.length ? `起量前预排除的未满30天零销量新品（${rampZero.length} 款）：${rampZero.map(r => `${escape(r.family_id)}（${escape(numberText(r.age_days))}天）`).join('；')}。` : ''}</p>`
      : '';
    return `<section class="ledger-section"><h3>正常新品：固定示例</h3>
      <p class="section-lead">${tLead}</p>
      <p class="muted">${selLead}</p>
      ${policyLine}
      ${stratHtml}
      ${loneHtml}${keepaAnomalySummaryHtml ? `\n      ${keepaAnomalySummaryHtml}` : ''}
      ${rampNote}
      ${examples.length ? `<dl class="kv-rows">${examples.map(example => {
        const raw = members.find(member => member?.family_id === example.family_id && member?.asin === example.asin) ?? {};
        const natural = object(example.natural);
        const ageTag = finite(example.age_days) ? ` · 上架 ${escape(numberText(example.age_days))} 天（${example.is_full_month ? '满30天强制' : '未满30天起量期'}）` : '';
        const revOrigin = rev >= 59 ? extractNewcomerReviewOriginBreakdown(raw) : null;
        const revOriginText = revOrigin
          ? ((typeof revOrigin.display_zh === 'string' && revOrigin.display_zh.trim())
            ? revOrigin.display_zh
            : (revOrigin.summary_zh ?? ''))
          : '';
        const revOriginLine = rev >= 59 && typeof revOriginText === 'string' && revOriginText.trim()
          ? `<p class="muted">代表新品评论构成：${escape(revOriginText.trim())}</p>`
          : '';
        const keepaAdv = rev >= 59 ? (anomalyByAsin.get(string(example.asin).trim().toUpperCase()) ?? null) : null;
        const keepaAdvLine = keepaAdv
          ? `<p class="muted">Keepa 评论变动：${escape(renderKeepaAdvisoryText(keepaAdv))}</p>`
          : (rev >= 59 && typeof raw.keepa_review_anomaly_advisory === 'string' && raw.keepa_review_anomaly_advisory.trim()
            ? `<p class="muted">Keepa 评论变动：${escape(scrubShareableText(raw.keepa_review_anomaly_advisory))}</p>`
            : '');
        return `<div class="kv-row"><dt><span class="mono-id">${escape(example.family_id)}</span>${pairKeys.has(`${example.family_id}\0${example.asin}`) ? ' · 已选示例 S*' : ' · 参照样本'}</dt><dd><div class="kv-main">评价数 ${escape(observed(raw.ratings))} · 近30天销量 ${escape(observed(raw.units_30d))} · 少评价得分 ${escape(numberText(example.score))} / 4${ageTag}</div><p class="muted">实际数量分 ${escape(numberText(example.actual_score))}；销量／参照中位数 ${escape(numberText(example.sales_ratio))}；销量封顶 ${escape(numberText(example.sales_ceiling))}。</p>${revOriginLine}${keepaAdvLine}${typeof raw.reason === 'string' ? `<p class="muted">纳入理由：${escape(raw.reason)}</p>` : ''}<p class="muted">自然曝光 ${escape(observed(natural.input))}（${natural.source_label === 'sif_with_sellersprite_corroboration' ? 'SIF占比＋SellerSprite旁证' : 'SIF单来源占比'}）· ${natural.score === null || natural.score === undefined ? escape(reasonText(natural.reason)) : `自然得分 ${escape(numberText(natural.score))} / 1`}${natural.input?.period ? ` · ${escape(readable(natural.input.period))}` : ''}</p>${natural.keyword_counts ? `<p class="muted">自然／广告词数：SellerSprite ${escape(numberText(natural.keyword_counts.sellersprite?.organic))} / ${escape(numberText(natural.keyword_counts.sellersprite?.ad))}；SIF ${escape(numberText(natural.keyword_counts.sif?.organic))} / ${escape(numberText(natural.keyword_counts.sif?.ad))}。</p>` : ''}${natural.coverage_exposure_mismatch && natural.coverage_exposure_diagnosis ? `<p class="ink-fail"><strong>自然诊断：</strong>${escape(natural.coverage_exposure_diagnosis)}</p>` : ''}</dd></div>`;
      }).join('')}</dl>` : ''}
      ${members.some(member => member?.effective_status && member.effective_status !== 'qualified') ? `<details class="quiet-fold"><summary>未纳入新品参照的其他榜单记录（${members.filter(m => m?.effective_status && m.effective_status !== 'qualified').length}）</summary><ul>${members.filter(member => member?.effective_status && member.effective_status !== 'qualified').map(member => `<li><span class="mono-id">${escape(member.family_id ?? member.asin ?? '未命名记录')}</span>（${escape(MEMBER_STATES[member.effective_status] ?? member.effective_status)}）：${escape(reasonText(member.reason))}</li>`).join('')}</ul></details>` : ''}
    </section>`;
}

function r57RevenueAllocationStrip(scenarios, rev = 57) {
  if (array(scenarios).some(sc => sc?.excluded_from_active_pricing !== true && sc?.comparability_linkage?.status === 'pending_evidence')) {
    return '';
  }
  const valid = scenarios
    .filter(sc => isScoredSupportedR58(sc))
    .map(sc => ({
      label: sanitizeTextPaths(string(sc?.input?.label, sc?.id ?? '当前情景')),
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
  const isBareGoodsAlloc = showsBareGoodsCost(calc);
  const supplyUsd = amt('procurement') + amt('domestic_freight') + amt('headhaul');
  const platformUsd = Math.max(0, calc.net_cost_usd - supplyUsd);
  const netRev = calc.net_revenue_usd;
  const contribUsd = netRev - calc.net_cost_usd;
  const posContrib = Math.max(0, contribUsd);
  const denom = Math.max(netRev, calc.net_cost_usd);
  const supplyPct = Math.min(100, Math.max(0, (supplyUsd / denom) * 100));
  const platformPct = Math.min(100 - supplyPct, Math.max(0, (platformUsd / denom) * 100));
  const marginPct = contribUsd > 0 ? Math.max(0, 100 - supplyPct - platformPct) : 0;
  const pass = calcMeetsFloor30(calc, sc) === true;
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
      <span><i class="swatch swatch-supply" aria-hidden="true"></i>${isBareGoodsAlloc ? '裸货采购＋头程' : '采购＋国内运＋头程'} <strong>${money(supplyUsd)}</strong>（${escape(numberText((supplyUsd / netRev) * 100))}%）</span>
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
  const refBidUsd = finite(result?.diagnostics?.bids?.reference_bid_usd) && result.diagnostics.bids.reference_bid_usd > 0
    ? result.diagnostics.bids.reference_bid_usd : null;
  const stressScenarios = array(diagnostics.stress_scenarios);
  const expectedPrimary = Array.isArray(diagnostics.expected_primary_scenarios) ? diagnostics.expected_primary_scenarios : [];

  const anyBareGoodsWaterfall = scenarios.some(sc => showsBareGoodsCost(sc?.input?.calculation));
  const cellAmount = (ledger, lineId) => {
    if (!ledger) return '未知';
    const pending = array(ledger.pending_lines);
    const deferred = array(ledger.deferred_lines);
    const line = array(ledger.lines).find(l => l.id === lineId);
    if (!line) return '–';
    if (lineId === 'domestic_freight' && showsBareGoodsCost(ledger)) return '未计入（裸货口径）';
    if (deferred.includes(lineId)) return pending.includes(lineId) ? '待补证' : '成对暂缓';
    if (pending.includes(lineId) || line.amount_usd === null) return '待补证';
    return money2(line.amount_usd);
  };

  const waterfallPeriodId = result?.id && Array.isArray(result?.months)
    ? result.id
    : (typeof diagnostics.operating_period_id === 'string' && diagnostics.operating_period_id.trim()
      ? diagnostics.operating_period_id.trim()
      : null);
  const scenarioLinks = scenarios.map(sc => effectiveScenarioLinkage(sc, original, waterfallPeriodId));
  const linkBadgeHtml = link => {
    if (!link?.status || link.status === 'undisputed') return '';
    if (link.status === 'confirmed_excluded') return '<span class="th-note ink-fail">证据已排除 · 不计同套售价</span>';
    if (link.status === 'pending_evidence') return '<span class="th-note">待补证 · 缺同规格确认</span>';
    if (link.status === 'ai_dispute_pending_ruling') return '<span class="th-note ink-fail">复核提出异议 · 待裁决</span>';
    if (link.status === 'ai_pending_evidence') return '<span class="th-note">待补证 · 复核提示待裁决</span>';
    if (link.status === 'confirmed_comparable') return '<span class="th-note ink-pass">裁决确认可比</span>';
    return '';
  };
  const linkShortCellNote = link => {
    if (!link?.status || link.status === 'undisputed' || link.status === 'confirmed_comparable') return '';
    if (link.status === 'confirmed_excluded') return '<span class="th-note ink-fail">证据已排除</span>';
    if (link.status === 'pending_evidence') return '<span class="th-note">待补证</span>';
    if (link.status === 'ai_dispute_pending_ruling') return '<span class="th-note ink-fail">复核提出异议 · 待裁决</span>';
    if (link.status === 'ai_pending_evidence') return '<span class="th-note">待补证 · 待裁决</span>';
    return '';
  };

  const hasCouponFeeScenario = sc => {
    const cl = sc?.input?.cost_ledger;
    const calc = sc?.input?.calculation;
    const anchor = sc?.input?.price_anchor;
    const otherLines = [
      array(calc?.lines).find(l => l?.id === 'other_applicable'),
      array(cl?.lines).find(l => l?.id === 'other_applicable'),
    ].filter(Boolean);
    return Boolean(
      (finite(cl?.ongoing_coupon_usd) && cl.ongoing_coupon_usd > 0) ||
      (finite(cl?.ongoing_coupon_pct) && cl.ongoing_coupon_pct > 0) ||
      (finite(cl?.coupon_redemption_fee_usd) && cl.coupon_redemption_fee_usd > 0) ||
      (finite(anchor?.ongoing_coupon_usd) && anchor.ongoing_coupon_usd > 0) ||
      (finite(anchor?.ongoing_coupon_pct) && anchor.ongoing_coupon_pct > 0) ||
      otherLines.some(l =>
        l.coupon_fee_included === true ||
        array(l.components).includes('coupon_redemption') ||
        (typeof l.basis === 'string' && /coupon|\$5\/100/i.test(l.basis)),
      ),
    );
  };
  const resolveCouponFeeDisplayMeta = sc => {
    const cl = sc?.input?.cost_ledger;
    const calc = sc?.input?.calculation;
    const calcCoupon = calc?.coupon_fee && typeof calc.coupon_fee === 'object' ? calc.coupon_fee : null;
    const otherLine = array(calc?.lines).find(l => l?.id === 'other_applicable') ??
      array(cl?.lines).find(l => l?.id === 'other_applicable') ?? null;
    const explicitUnitsRaw = calcCoupon?.coupon_campaign_units ??
      otherLine?.coupon_campaign_units ??
      calc?.coupon_campaign_units ??
      cl?.coupon_campaign_units ??
      cl?.source_inputs?.coupon_campaign_units ?? null;
    const explicitUnits = Number.isSafeInteger(explicitUnitsRaw) && explicitUnitsRaw > 0 ? explicitUnitsRaw : null;
    let flatIncluded = !(
      cl?.include_coupon_campaign_flat === false ||
      calc?.include_coupon_campaign_flat === false ||
      calcCoupon?.include_campaign_flat_usd === false ||
      calcCoupon?.include_coupon_campaign_flat === false ||
      otherLine?.include_coupon_campaign_flat === false ||
      otherLine?.include_campaign_flat_usd === false
    );
    let appliedUnits = explicitUnits;
    const pureCouponOther = Boolean(
      otherLine?.coupon_fee_included === true &&
      otherLine?.payee === 'amazon' &&
      typeof otherLine?.basis === 'string' &&
      /^Amazon ongoing coupon redemption fee\b/i.test(otherLine.basis.trim()) &&
      finite(otherLine.amount_usd),
    );
    if (pureCouponOther && finite(calc?.price_usd) && calc.price_usd > 0) {
      const share = finite(cl?.coupon_redemption_share) && cl.coupon_redemption_share >= 0 && cl.coupon_redemption_share <= 1
        ? cl.coupon_redemption_share
        : 1;
      const varFee = 0.025 * calc.price_usd * share;
      const flatDelta = otherLine.amount_usd - varFee;
      if (flatDelta < 1e-5) {
        flatIncluded = false;
        appliedUnits = null;
      } else if (appliedUnits === null) {
        const inferred = Math.round(5 / flatDelta);
        if (Number.isSafeInteger(inferred) && inferred > 0 && Math.abs((5 / inferred) - flatDelta) < 1e-4) {
          appliedUnits = inferred;
        }
      }
    }
    if (flatIncluded && appliedUnits === null && typeof otherLine?.basis === 'string') {
      const m = otherLine.basis.match(/\$5\/(\d+)/);
      if (m) {
        const parsed = Number.parseInt(m[1], 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) appliedUnits = parsed;
      }
    }
    if (flatIncluded && appliedUnits === null) appliedUnits = 100;
    return {
      flatIncluded,
      campaignUnits: flatIncluded ? appliedUnits : null,
    };
  };
  const couponMetas = scenarios.filter(hasCouponFeeScenario).map(resolveCouponFeeDisplayMeta);
  const couponFlatUnitsList = [...new Set(couponMetas.filter(m => m.flatIncluded).map(m => m.campaignUnits).filter(Boolean))];
  const hasCouponFlatDisabled = couponMetas.some(m => !m.flatIncluded);
  let couponThNote = '';
  let couponAmortizationNote = '';
  if (couponMetas.length > 0) {
    if (couponFlatUnitsList.length > 0 && !hasCouponFlatDisabled) {
      const unitsTag = couponFlatUnitsList.join('／');
      couponThNote = `$5/${unitsTag} + 2.5% 核券分母提示`;
      couponAmortizationNote = `含亚马逊优惠券费（$5/${unitsTag} + 2.5%：单场 $5 固定活动费 + 核券成交额 2.5%）；其中 $5 固定费按实际核券成交订单数分摊（当前按 ${unitsTag} 笔核券单计，不与 100 套采购量挂钩；若单场仅核销 20 笔，单笔固定费升至 $0.25），FBA 配送费档位仍按券前标价判断。`;
    } else if (couponFlatUnitsList.length === 0) {
      couponThNote = '2.5% 核券变动费口径（未计单场 $5 固定费）';
      couponAmortizationNote = '含亚马逊优惠券变动费（核券成交额 2.5%）；本情景已关闭单场 $5 固定活动费摊销（未计入 $5 固定费；如实际发生，应按实际核券成交订单数分摊，不与 100 套采购量挂钩），FBA 配送费档位仍按券前标价判断。';
    } else {
      const unitsTag = couponFlatUnitsList.join('／');
      couponThNote = '优惠券费口径与核券分母提示';
      couponAmortizationNote = `含亚马逊优惠券费：含固定费情景按 $5/${unitsTag} + 2.5% 核算（其中 $5 固定费按实际核券成交订单数分摊，当前按 ${unitsTag} 笔核券单计，不与 100 套采购量挂钩）；另有关闭单场 $5 固定费情景仅计核券成交额 2.5% 变动费。FBA 配送费档位仍按券前标价判断。`;
    }
  }
  const breakEvenById = new Map(
    array(diagnostics.break_even_click_cvr?.scenarios)
      .filter(row => row && typeof row === 'object' && typeof row.id === 'string')
      .map(row => [row.id, row]),
  );
  const allScenariosExcluded = scenarios.length > 0 && scenarios.every((sc, idx) =>
    sc.excluded_from_active_pricing === true || scenarioLinks[idx]?.status === 'confirmed_excluded',
  );
  const hasAnyUsableAdScenario = scenarios.some((sc, idx) => {
    const link = scenarioLinks[idx];
    return sc.excluded_from_active_pricing !== true &&
      link?.status !== 'confirmed_excluded' &&
      link?.status !== 'pending_evidence' &&
      isUsableActivePricingScenario(sc);
  });

  const r58ExtraRows = `
          <tr><th scope="row">${anyBareGoodsWaterfall ? '保 30% 毛利对应 1688 裸货上限' : '保 30% 毛利对应到深含运采购上限'}<span class="th-note">${anyBareGoodsWaterfall ? '按 1688 裸货初筛口径（(0.70×R − A)×FX），不含国内到深圳运费' : '含采购＋国内运（(0.70×R − A)×FX）；与上方裸货采购上限区分'}</span></th>${scenarios.map(sc => {
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
          <tr><th scope="row">${anyBareGoodsWaterfall ? '单件参考本金（1688 裸货 + 头程）' : '单件落地本金（采购 + 国内运费 + 头程）'}<span class="th-note">仅作资金门槛参考，不算强制周转月数</span></th>${scenarios.map(sc => {
            const c = sc.input?.calculation;
            const cl = sc.input?.cost_ledger;
            const si = cl?.source_inputs;
            const procLineRaw = array(cl?.lines).find(l => l?.id === 'procurement');
            const domLineRaw = array(cl?.lines).find(l => l?.id === 'domestic_freight');
            const fxVal = [si?.fx_cny_per_usd, si?.fx_usdcny, cl?.fx_cny_per_usd, procLineRaw?.fx_cny_per_usd, domLineRaw?.fx_cny_per_usd]
              .find(v => finite(v) && v > 0) ?? null;
            const pendingSet = new Set(array(c?.pending_lines));
            const bareSc = showsBareGoodsCost(c);
            const procUsd = pendingSet.has('procurement') ? null : array(c?.lines).find(l => l?.id === 'procurement')?.amount_usd;
            const domUsd = bareSc ? 0 : (pendingSet.has('domestic_freight') ? null : array(c?.lines).find(l => l?.id === 'domestic_freight')?.amount_usd);
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
          }).join('')}</tr>${anyBareGoodsWaterfall ? (() => {
            const advisoryRefs = [...new Set(scenarios.flatMap(sc => {
              const cl = sc?.input?.cost_ledger;
              const si = cl?.source_inputs;
              const domLineRaw = array(cl?.lines).find(l => l?.id === 'domestic_freight');
              const refs = [];
              if (typeof si?.domestic_freight_advisory_note === 'string' && si.domestic_freight_advisory_note.trim()) {
                refs.push(sanitizeTextPaths(si.domestic_freight_advisory_note.trim()));
              }
              if (finite(domLineRaw?.domestic_freight_advisory_cny_total)) {
                refs.push(`页面展示国内运费参考 ¥${numberText(domLineRaw.domestic_freight_advisory_cny_total)}（仅备注，不卡 30% 红线）`);
              }
              return refs;
            }))];
            const advisorySuffix = advisoryRefs.length ? `（参考备注：${advisoryRefs.join('；')}）` : '';
            return `
          <tr><th scope="row">裸货口径说明<span class="th-note">1688 常规 100 套初筛标准披露</span></th><td colspan="${scenarios.length}">${escape(BARE_GOODS_DISCLOSURE_ZH)}${escape(advisorySuffix)}</td></tr>`;
          })() : ''}${couponAmortizationNote ? `
          <tr><th scope="row">优惠券营销费口径说明<span class="th-note">${escape(couponThNote)}</span></th><td colspan="${scenarios.length}">${escape(couponAmortizationNote)}</td></tr>` : ''}${(() => {
            const replNotes = [...new Set(scenarios.map(sc =>
              sc?.input?.calculation?.advisory_replenishment_note ??
              sc?.input?.calculation?.headhaul_a4_applied?.advisory_replenishment_note ??
              null,
            ).filter(n => typeof n === 'string' && n.trim()))];
            if (!replNotes.length) return '';
            return `
          <tr><th scope="row">稳态补货门槛提示<span class="th-note">海卡单仓 ≥50 kg 参考，不拖累主毛利</span></th><td colspan="${scenarios.length}">${escape(replNotes.join('；'))}</td></tr>`;
          })()}${(() => {
            const rawLabNote = original?.one_time_lab_fee_note ?? original?.compliance_lab_fee_note ?? original?.presentation?.one_time_lab_fee_note ?? null;
            const rawLabUsd = original?.one_time_compliance_fee_usd ?? original?.one_time_lab_fee_usd ?? null;
            if (!rawLabNote && !finite(rawLabUsd)) return '';
            const labText = typeof rawLabNote === 'string' && rawLabNote.trim()
              ? sanitizeTextPaths(rawLabNote.trim())
              : `预估约 US$ ${numberText(rawLabUsd)}（一次性投入，不摊进单件毛利）`;
            return `
          <tr><th scope="row">一次性实验室／合规检测费提醒<span class="th-note">独立列示于首批参考本金旁 · 不摊入单件毛利、不设硬红线</span></th><td class="num-col" colspan="${scenarios.length}">${escape(labText)}</td></tr>`;
          })()}` : ''}${(refBidUsd !== null || allScenariosExcluded) ? `
          <tr><th scope="row">广告盈亏平衡所需点击转化率<span class="th-note">广告订单数 ÷ 广告点击数；仅可与点击转化率 clickConvRate 对照，严禁与搜索购买率 purchaseRate 混比</span>${!hasAnyUsableAdScenario ? '<span class="th-note">无已确认可用主情景 · 广告盈亏平衡待补证</span>' : ''}</th>${scenarios.map((sc, idx) => {
            const link = scenarioLinks[idx];
            if (sc.excluded_from_active_pricing === true || link?.status === 'confirmed_excluded') {
              return '<td class="num-col ink-muted">证据已排除</td>';
            }
            if (refBidUsd === null || link?.status === 'pending_evidence' || !isUsableActivePricingScenario(sc)) {
              return '<td class="num-col ink-muted">待补证</td>';
            }
            const beRow = breakEvenById.get(sc.id);
            const diagCvr = finite(beRow?.break_even_click_cvr) && beRow.break_even_click_cvr > 0
              ? beRow.break_even_click_cvr
              : null;
            const contrib = sc.input?.contribution_usd?.value;
            const cvr = diagCvr ?? (finite(contrib) && contrib > 0 ? refBidUsd / contrib : null);
            return cvr !== null
              ? `<td class="num-col">${escape(numberText(cvr * 100))}%${link?.needs_ruling ? linkShortCellNote(link) : ''}</td>`
              : '<td class="num-col ink-muted">待补证</td>';
          }).join('')}</tr>` : ''}`;

  const stressHasCoupon = stressScenarios.some(st =>
    array(st?.calculation?.lines).some(l => l?.coupon_fee_included === true || (typeof l?.basis === 'string' && /coupon|\$5\/100/i.test(l.basis))) ||
    /coupon|\$5\/100/i.test(string(st?.stress_type)) ||
    array(st?.assumptions).some(a => /\$5\/100|coupon/i.test(string(a))),
  );
  const stressSection = stressScenarios.length ? `
    <div class="quiet-surface" data-section="stress-scenarios">
      <h3>独立压力情景（仅作敏感度观察，不计入 21 项主分与 30% 淘汰线）</h3>
      <dl class="kv-rows">${stressScenarios.map(st => {
        const mText = finite(st.margin) ? `${escape(numberText(st.margin * 100))}%` : '待补证';
        const cText = finite(st.contribution_usd) ? money2(st.contribution_usd) : '待补证';
        const adText = finite(st.advertising_scenario_margin) ? `${escape(numberText(st.advertising_scenario_margin * 100))}%` : '待补证';
        const capCny = finite(st.landed_domestic_cap_at_30pct_cny) ? `（约 ¥${escape(numberText(st.landed_domestic_cap_at_30pct_cny))}）` : '';
        const capText = finite(st.landed_domestic_cap_at_30pct_usd) ? `；${anyBareGoodsWaterfall ? '保30%裸货上限' : '保30%到深含运上限'} ${money2(st.landed_domestic_cap_at_30pct_usd)}${capCny}` : '';
        const stExcl = st.excluded_from_active_pricing === true;
        const stBadge = stExcl ? '<span class="th-note ink-fail">证据已排除 · 原始压力试算留档</span>' : '';
        const issues = array(st.stress_issues);
        const issuesHtml = issues.length
          ? `<p class="${st.double_deduction_blocked ? 'ink-fail' : 'muted'}"><strong>压力情景核查提示：</strong>${issues.map(iss => escape(sanitizeTextPaths(string(iss?.reason ?? iss)))).join('；')}</p>`
          : '';
        return `<div class="kv-row"><dt>${escape(sanitizeTextPaths(string(st.label ?? st.id, '压力情景')))}${stBadge}</dt><dd><div class="kv-main${stExcl ? ' ink-muted' : ''}">压力售价 ${money2(st.price_usd)} · 广告前毛利率 ${mText} · 单件贡献 ${cText} · 扣15%广告后 ${adText}${capText}</div>${issuesHtml}${array(st.assumptions).length ? `<p class="muted">${st.assumptions.map(a => escape(readableSanitized(a))).join('；')}</p>` : ''}</dd></div>`;
      }).join('')}</dl>${stressHasCoupon && !couponAmortizationNote ? '<p class="muted">优惠券费分母提示：若计入单场 $5 固定活动费，应按实际核券成交订单数分摊，不与 100 套采购量挂钩。</p>' : ''}
    </div>` : '';

  const expectedPrimaryLabelOf = e => {
    if (e.verdict === 'evidenced_cancellation') {
      return `有据撤销：${escape(sanitizeTextPaths(string(e.reason)))}`;
    }
    if (e.verdict !== 'present') return escape(e.verdict);
    const scIdx = scenarios.findIndex(s => s?.id === e.id);
    const sc = scIdx >= 0 ? scenarios[scIdx] : null;
    const link = scIdx >= 0 ? scenarioLinks[scIdx] : null;
    if (sc?.excluded_from_active_pricing === true || link?.status === 'confirmed_excluded') {
      return '已裁决排除 · 原始报价留档';
    }
    if (link?.status === 'pending_evidence') {
      return '待补证 · 暂不计入达标';
    }
    const baseState = sc?.single_factory_complete_kit?.is_cross_factory_or_incomplete
      ? '跨厂拼套 · 不计入围'
      : sc?.input?.calculation?.status === 'sensitivity_only'
        ? '条件试算 · 不计分'
        : sc && !isUsableActivePricingScenario(sc)
          ? '待补证 · 暂不计入达标'
          : '已纳入';
    if (link?.status === 'ai_dispute_pending_ruling') {
      return `${baseState} · 复核提出异议待裁决`;
    }
    if (link?.status === 'ai_pending_evidence') {
      return `${baseState} · 复核提示待补证`;
    }
    if (link?.status === 'confirmed_comparable') {
      return `裁决确认可比 · ${baseState}`;
    }
    return baseState;
  };
  const expectedPrimaryNote = expectedPrimary.length ? `<p class="muted">预声明主情景核验：${expectedPrimary.map(e => `${escape(e.id)}（${expectedPrimaryLabelOf(e)}）`).join('；')}。</p>` : '';

  return `<section class="ledger-section">
    <div class="section-head"><h3>单件利润与费用拆解</h3><span class="muted">可售单位：${escape(diagnostics.saleable_unit ?? '未知')}</span></div>
    ${r57RevenueAllocationStrip(scenarios, rev)}
    <div tabindex="0" role="region" aria-labelledby="${escape(tableCaptionId)}" class="table-scroll">
      <table class="hairline-table waterfall-table">
        <caption id="${escape(tableCaptionId)}" class="sr-only">各情景单件收入、成本与毛利率对比</caption>
        <thead>
          <tr>
            <th scope="col">核算项目</th>
            ${scenarios.map((sc, idx) => {
              const calc = sc.input?.calculation;
              const cond = calc?.status === 'sensitivity_only';
              const kit = sc.single_factory_complete_kit ?? calc?.single_factory_complete_kit ?? evaluateSingleFactoryCompleteKit({ scenario: sc.input, cost_ledger: sc.input?.cost_ledger });
              const dispLabel = sanitizeTextPaths(string(sc.input?.label, sc.id ?? '未命名情景'));
              const kitNote = kit?.is_cross_factory_or_incomplete ? '<span class="th-note">跨厂拼套·不计入围</span>' : '';
              return `<th scope="col" class="num-col">${escape(dispLabel)}${cond ? '<span class="th-note">条件试算·不计分</span>' : ''}${kitNote}${linkBadgeHtml(scenarioLinks[idx])}</th>`;
            }).join('')}
          </tr>
        </thead>
        <tbody>
          <tr><th scope="row">美站销售定价</th>${scenarios.map((sc, idx) => {
            const link = scenarioLinks[idx];
            const isExcl = link?.status === 'confirmed_excluded' || sc.excluded_from_active_pricing === true;
            const priceHtml = isExcl
              ? `<s class="ink-muted">${money2(sc.input?.calculation?.price_usd)}</s>`
              : `<strong>${money2(sc.input?.calculation?.price_usd)}</strong>`;
            return `<td class="num-col${isExcl ? ' ink-muted' : ''}">${priceHtml}${linkShortCellNote(link)}</td>`;
          }).join('')}</tr>
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
          <tr class="row-sum"><th scope="row">退款调整后广告前毛利率（门槛 30%）</th>${scenarios.map((sc, idx) => {
            const c = sc.input?.calculation;
            const cond = c?.status === 'sensitivity_only';
            const m = cond ? { value: c.margin, unit: 'fraction' } : sc.input?.margin;
            const link = scenarioLinks[idx];
            const isExcl = link?.status === 'confirmed_excluded' || sc.excluded_from_active_pricing === true;
            const pass30 = !isExcl && isScoredSupportedR58(sc) && finite(m?.value) ? calcMeetsFloor30(c, sc) : null;
            const tone = isExcl ? 'ink-muted' : pass30 === true ? 'ink-pass' : pass30 === false ? 'ink-fail' : 'ink-muted';
            const valHtml = isExcl ? `<s>${escape(observed(m))}</s>` : `<strong>${escape(observed(m))}</strong>`;
            return `<td class="num-col ${tone}">${valHtml}${linkShortCellNote(link)}</td>`;
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
    <div class="scenario-folds">${scenarios.map((scenario, idx) => {
      const calculation = scenario.input?.calculation;
      const conditional = calculation?.status === 'sensitivity_only';
      const validation = object(calculation?.fee_validation);
      const context = object(validation.context);
      const windowText = window => window ? `${window.from} 至 ${window.through}` : '待补证';
      const link = scenarioLinks[idx];
      const linkReason = scrubShareableText(link?.reason);
      const linkSource = scrubShareableText(link?.source);
      const linkPeer = scrubShareableText(link?.peer_asin);
      const explanation = link?.status === 'confirmed_excluded' ? '证据已排除（规格不符，不计入同套售价与毛利区间，原始报价保留备查）。' :
        link?.status === 'pending_evidence' ? '待补证（对标同箱规格未确认，暂停计入达标）。' :
        conditional ? '费用已算出，但售价或其他情景假设尚未确认；不授予经济分。' :
        scenario.coherence_supported === true && scenario.margin_eligible === true
          ? (link?.needs_ruling ? '该情景满足毛利条件（注：独立复核提出异议／待补证，待正式裁决）。' : '该情景满足毛利条件。') :
          calculation && !calculation.scoring_supported ? `完整费用尚待补证：${array(calculation.pending_lines).map(id => COST_LABELS[id] ?? id).join('、') || '费率适用日期或来源'}。见下方核对。` :
            reasonText(scenario.eligibility_reason ?? scenario.margin?.reason ?? '该情景尚不满足或尚不能判断毛利条件。');
      const linkFoldNote = link && link.status && link.status !== 'undisputed'
        ? (() => {
          const headingMap = {
            confirmed_excluded: '对标可比性正式裁决 · 证据已排除',
            pending_evidence: '对标可比性正式裁决 · 待补证',
            ai_dispute_pending_ruling: '独立复核提出异议 · 待裁决（仅提醒，正式裁决前不改计分）',
            ai_pending_evidence: '独立复核提示待补证 · 待裁决（仅提醒，正式裁决前不改计分）',
            confirmed_comparable: '对标可比性正式裁决 · 确认可比',
          };
          const cls = link.status === 'confirmed_excluded' || link.status === 'ai_dispute_pending_ruling'
            ? 'ink-fail'
            : link.status === 'confirmed_comparable' ? 'ink-pass' : 'muted';
          const metaParts = [linkPeer ? `对标 ${linkPeer}` : '', linkSource ? `来源 ${linkSource}` : ''].filter(Boolean).join(' · ');
          return `<p class="${cls}"><strong>${escape(headingMap[link.status] ?? link.status)}</strong>${metaParts ? `（${escape(metaParts)}）` : ''}${linkReason ? `：${escape(linkReason)}` : ''}</p>`;
        })()
        : '';
      const adNote = calculation && finite(calculation.advertising_scenario_margin) && finite(calculation.advertising_scenario_contribution_usd)
        ? `售价15%广告敏感度参考（US$ ${escape(numberText(calculation.advertising_15pct_usd))}）：广告后单件贡献 US$ ${escape(numberText(calculation.advertising_scenario_contribution_usd))}，广告后毛利率 ${escape(numberText(calculation.advertising_scenario_margin * 100))}%${finite(calculation.procurement_cap_at_30pct_usd) ? `；30%广告前毛利对应采购单价上限 US$ ${escape(numberText(calculation.procurement_cap_at_30pct_usd))}` : ''}（仅作敏感度参考，不改变主毛利计分）。`
        : '';
      const retComp = calculation?.returns_processing_components ?? null;
      const retNote = retComp
        ? `退货费口径：退款率 r_refund=${escape(numberText(retComp.r_refund * 100))}%，实物退货率 r_physical=${escape(numberText(retComp.r_physical * 100))}%${retComp.return_threshold !== null ? `，类目阈值 ${escape(numberText(retComp.return_threshold * 100))}%` : ''}，超阈费 US$ ${escape(numberText(retComp.expected_fee_per_shipped_unit_usd))}。`
        : '';
      const scCouponNote = (() => {
        if (!hasCouponFeeScenario(scenario)) return '';
        const meta = resolveCouponFeeDisplayMeta(scenario);
        if (!meta.flatIncluded) {
          return '优惠券费口径：本情景仅计核券成交额 2.5% 变动费，未计入单场 $5 固定活动费（如实际发生，应按实际核券成交订单数分摊，不与 100 套采购量挂钩）；FBA 配送费档位仍按券前标价核算。';
        }
        return `优惠券费口径：$5/${meta.campaignUnits} + 2.5% 中的 $5 固定活动费按实际核券成交订单数分摊（当前按 ${meta.campaignUnits} 笔核券单计），不与 100 套采购量挂钩；FBA 配送费档位仍按券前标价核算。`;
      })();
      const foldTitle = sanitizeTextPaths(string(scenario.input?.label, scenario.id ?? '未命名情景'));
      const kit = scenario.single_factory_complete_kit ?? calculation?.single_factory_complete_kit ?? evaluateSingleFactoryCompleteKit({ scenario: scenario.input, cost_ledger: scenario.input?.cost_ledger });
      const kitFoldNote = kit?.is_cross_factory_or_incomplete
        ? `<p class="ink-fail"><strong>单厂齐套核查未通过（保留采购情景供复核，不计入入围）：</strong>${escape(kit.kit_note ?? INCOMPLETE_CROSS_FACTORY_KIT_NOTE_ZH)}${kit.distinct_factory_count > 1 ? `（检测到 ${escape(String(kit.distinct_factory_count))} 家不同工厂拼套）` : ''}。</p>`
        : '';
      return `<details class="quiet-fold"><summary>${escape(foldTitle)} · ${escape(explanation)}</summary><div class="fold-body">${linkFoldNote}${kitFoldNote}${calculation ? `<p class="muted">适用窗口 · 销售：${escape(windowText(context.sales))}；仓储：${escape(windowText(context.storage))}；入库：${escape(windowText(context.inbound))}。费率核验：${validation.status === 'validated' ? '通过' : '存在待补证项'}。</p>` : ''}${adNote ? `<p class="muted">${adNote}</p>` : ''}${retNote ? `<p class="muted">${retNote}</p>` : ''}${scCouponNote ? `<p class="muted">${escape(scCouponNote)}</p>` : ''}${array(validation.issues).length ? `<ul>${validation.issues.map(issue => `<li><strong>${escape(COST_LABELS[issue.line] ?? '费用情景')}</strong>：${escape(issue.code === 'domestic_quote_required' ? '修订58要求提供整数 order_units >= 100 的非首单常规复购货款与国内运费报价（且须与 source_inputs/sku_lines 口径一致，first_order_promotion: false）。' : (FEE_ISSUES[issue.code] ?? sanitizeTextPaths(string(issue.reason))))}</li>`).join('')}</ul>` : ''}${array(scenario.input?.assumptions).length ? `<ul>${scenario.input.assumptions.map(value => `<li>${escape(readableSanitized(value))}</li>`).join('')}</ul>` : ''}</div></details>`;
    }).join('')}</div>
  </section>`;
}

function r57ScoreRows(result, registry, prefix, rev = result?.profile_revision ?? 0) {
  const newcomerDiag = object(result.diagnostics?.newcomers);
  return `<div class="score-columns">${array(result.groups).map(group => {
    const rows = array(result.items).filter(item => item.group === group.id);
    const gTitle = escape(GROUP_LABELS[group.id] ?? group.id);
    return `<section class="score-group" data-group-id="${escape(group.id)}">
      <div class="group-bar">
        <strong class="group-title">${gTitle}</strong>
        <span class="group-pts">${escape(rangeText(group.supported_range))} / ${escape(numberText(group.weight))} <span class="muted">（覆盖 ${escape(numberText(group.covered_weight))}）</span></span>
      </div>
      <div class="group-list">${rows.map(item => {
        const scored = item.status === 'scored' && Array.isArray(item.score_range);
        const scoreCls = scored ? '' : item.status === 'ineligible' ? 'ink-fail' : 'ink-muted';
        const r58Q31Inline = (item.id === 'low_rating_sales_performance' || item.id === 'natural_visibility_development')
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
            <strong class="item-title">${itemTitle}</strong>
            <p class="item-score ${scoreCls}">${scored ? `${escape(rangeText(item.score_range))} / ${escape(numberText(item.weight))} 分` : item.status === 'ineligible' ? '当前情景不适用合格评分' : '待补证'}</p>
          </div>
          <p class="item-input">${escape(inputSummary(item, rev))}</p>${r58Q31Inline}
          ${item.reason ? `<p class="item-reason">${escape(rev >= 59 ? unifyFactoryInquiryLabel(reasonText(item.reason)) : reasonText(item.reason))}</p>` : ''}
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
  const storeLeads = array(discovery?.store_leads);
  if (!discovery || (!kwLeads.length && !storeLeads.length)) return '';
  const kwSep = '·';
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

function r57OperationalDisclosures(result, rev = 0) {
  const items = array(result?.diagnostics?.operational_disclosures);
  if (!items.length) return '';
  const alertCount = items.filter(i => i?.status === 'alert').length;
  const toneOf = s => s === 'alert' ? 'fail' : s === 'needs_check' ? 'pending' : (s === 'clear' || s === 'disclosed') ? 'pass' : 'muted';
  const labelOf = s => ({ alert: '需排雷', needs_check: '待核查', clear: '已核无碍', disclosed: '已披露', unverified: '待补参数' }[s] ?? '待补参数');
  return `<section class="ledger-section" data-section="operational-disclosures"><details class="quiet-fold"${alertCount > 0 ? ' open' : ''}><summary>运营排雷与实操核查（6 项零否决披露 · ${alertCount > 0 ? `${alertCount} 项预警` : '无即时红旗'}）</summary><div class="fold-body"><dl class="kv-rows">${items.map(item => `<div class="kv-row"><dt>${escape(string(item?.label, item?.id ?? '核查项'))}</dt><dd><div class="kv-main"><span class="state-inline state-${toneOf(item?.status)}"><i class="dot" aria-hidden="true"></i>${escape(labelOf(item?.status))}</span></div><p class="muted">${escape(sanitizeTextPaths(string(item?.note, '待下单前确认。')))}</p></dd></div>`).join('')}</dl><p class="muted">以上 6 项仅作下单前实操排雷披露，不改变 21 项评分与 30% 毛利筛线。</p></div></details></section>`;
}

function r57ReviewNotes(result, original, rev = 0) {
  const rawNotes = array(result?.review_notes ?? original?.review_notes);
  if (!rawNotes.length) return '';
  const notes = redactShareableReviewTree(rawNotes);
  return `<section class="quiet-surface" data-section="review-notes"><h3>独立复核与校准备注（CALIBRATION_NOTE）</h3><ul class="brief-list">${notes.map(n => {
    if (typeof n === 'string') return `<li>${escape(n)}</li>`;
    const head = [n?.kind ?? n?.tag, n?.reviewer, n?.observed_at ?? n?.date].filter(v => Boolean(v) && v !== '[REDACTED_PII]').join(' · ');
    const body = string(n?.note ?? n?.text ?? readableSanitized(n));
    return `<li>${head ? `<strong>${escape(head)}：</strong>` : ''}${escape(body)}</li>`;
  }).join('')}</ul></section>`;
}

function r59PackagingRedesignAppendix(result, batch, rev = 0) {
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

function renderComparisonMatrix(candidates, originals, rev = 57) {
  if (!candidates.length) return '';
  const snaps = candidates.map(cand => extractMetricsSnapshot(cand, rev, originals.get(cand?.candidate_id)));
  const anyOver100 = snaps.some(s => s.orderUnitsRange && s.orderUnitsRange[1] > 100);
  const allBareGoodsMatrix = snaps.length > 0 && snaps.every(s => s.isBareGoods);
  const anyBareGoodsMatrix = snaps.some(s => s.isBareGoods);
  const mixedBareGoodsMatrix = anyBareGoodsMatrix && !allBareGoodsMatrix;
  const domesticColHeader = allBareGoodsMatrix
    ? (anyOver100 ? '1688裸货' : '1688百套裸货')
    : (mixedBareGoodsMatrix ? '1688货价口径' : (anyOver100 ? '1688到深含运' : '1688百套含运'));
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
            const bucketAttr = ` data-bucket="${candidateFilterBucket(cand, rev)}"`;
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
            const mCls = snap.marginFloorStatus === 'pass'
              ? 'ink-pass'
              : (snap.marginFloorStatus === 'fail' ? 'ink-fail' : (snap.marginFloorStatus === 'cross' ? '' : 'ink-muted'));
            const unitsSuffix = anyOver100 && snap.orderUnitsRange && snap.orderUnitsRange[1] > 100
              ? `（${escape(rangeText(snap.orderUnitsRange))}套）` : '';
            const basisSuffix = mixedBareGoodsMatrix
              ? (snap.isBareGoods ? '<span class="th-note">裸货口径</span>' : '<span class="th-note">含运口径</span>')
              : '';
            return `<tr data-eligible="${eligible ? 'true' : 'false'}"${bucketAttr}>
              <th scope="row"><a class="row-jump" href="#candidate-${idx + 1}"><span class="mono-idx">${String(idx + 1).padStart(2, '0')}</span>${escape(cand.label ?? cand.candidate_id)}</a></th>
              <td>${renderDotStatus(cand, snap, rev)}</td>
              <td class="num-col">${usdRangeText(snap.prices)}</td>
              <td class="num-col">${snap.cnyTotals ? `${escape(rangeText(snap.cnyTotals))} 元` : usdRangeText(snap.domesticDelivered)}${unitsSuffix}${basisSuffix}</td>
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

function r57DiscoverySummary(summary) {
  if (!summary || !finite(summary.unique_keywords)) return '';
  const seasonal = summary.dispositions?.seasonal_deferred ?? 0;
  return `<p class="batch-counts">来源词 ${escape(numberText(summary.unique_keywords))} 个；已核对 ${escape(numberText(summary.reviewed_keywords))} 个，待核 ${escape(numberText(summary.pending_keywords - seasonal))} 个，暂缓 ${escape(numberText(seasonal))} 个，搁置专属或无关搜索 ${escape(numberText(summary.excluded_keywords))} 个；已绑定实物候选 ${escape(numberText(summary.bound_candidates))} 个。词数不等于产品数，绑定不代表评分通过。</p>`;
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

function renderR58ExhibitionReel(candidates, originals, rev, imagePool) {
  if (!candidates.length) return '';
  const cols = Math.min(5, Math.max(2, candidates.length));
  return `<section class="exhibition-reel" style="--reel-cols:${cols}" aria-label="本批候选展列">
    ${candidates.map((cand, idx) => {
      const orig = originals.get(cand?.candidate_id);
      const pres = object(orig?.presentation);
      const snap = extractMetricsSnapshot(cand, rev, orig);
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
      const plinthAlt = string(pres.image_alt, shortTitle);
      const plinthMediaHtml = plinthImg
        ? imagePool.renderImage(plinthImg, { alt: plinthAlt, mode: 'cover', width: 960, height: 720, lazy: false })
        : '';

      return `<a class="plinth-item${staggerCls}" href="#candidate-${idx + 1}" data-eligible="${eligible ? 'true' : 'false'}" data-bucket="${bucket}">
        ${plinthImg
          ? `<div class="plinth-photo">${plinthMediaHtml}</div>`
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
    } else if (snapshot.marginFloorStatus === 'cross') {
      const isExcludedOrDeferred = snapshot.target?.queue === 'excluded' || snapshot.target?.queue === 'deferred';
      if (isExcludedOrDeferred) {
        deltaHtml = `<span class="ink-fail">${snapshot.target?.queue === 'deferred' ? '本期暂缓（不计入入围）' : '当前规格已排除（不计入入围）'}</span> · <span class="muted">情景毛利区间含高于与低于 30% 项</span>`;
      } else if (snapshot.crossingPassSummary && snapshot.crossingBelowSummary) {
        deltaHtml = `<span class="muted">跨 30% 红线（整卡未达标，不计入入围目标）：</span><span class="ink-pass">仅部分情景达标可做：${escape(snapshot.crossingPassSummary)}</span> · <span class="ink-fail">未过 30% 红线：${escape(snapshot.crossingBelowSummary)}</span>`;
      } else {
        deltaHtml = '<span class="muted">跨 30% 红线（整卡未达标，不计入入围目标）· 广告前净毛利率</span>';
      }
    }
  }
  const domesticMain = snapshot.cnyTotals
    ? `${escape(rangeText(snapshot.cnyTotals))} 元`
    : usdRangeText(snapshot.domesticDelivered);
  const domesticSub = snapshot.cnyTotals && snapshot.domesticDelivered
    ? `（${usdRangeText(snapshot.domesticDelivered)}）`
    : '';
  const domesticLabel = snapshot.isBareGoods
    ? (snapshot.orderUnitsRange && snapshot.orderUnitsRange[1] > 100
      ? `1688裸货（${escape(rangeText(snapshot.orderUnitsRange))}套）`
      : '1688百套裸货')
    : (snapshot.orderUnitsRange && snapshot.orderUnitsRange[1] > 100
      ? `1688到深含运（${escape(rangeText(snapshot.orderUnitsRange))}套）`
      : '1688百套含运');
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
          <span>${snapshot.isBareGoods ? '保 30% 裸货封顶' : '保 30% 到深封顶'}</span>
          <strong class="num">${capDisplay}</strong>
        </div>
        <div class="sm-side-item">
          <span>单件净留存</span>
          <strong class="num">${usdRangeText(snapshot.contributions)}</strong>
        </div>
      </div>
    </div>
    <p class="hero-stat-sub">${deltaHtml}</p>${snapshot.aiDisputeCount > 0 ? `\n    <p class="hero-stat-sub ink-fail">独立复核对 ${escape(numberText(snapshot.aiDisputeCount))} 个对标情景提出异议／待补证（待裁决，正式裁决前不改动毛利与总分）</p>` : ''}${(snapshot.excludedPeerCount > 0 || snapshot.pendingPeerCount > 0) ? `\n    <p class="hero-stat-sub muted">已联动对标裁决重算：排除错规格 ${escape(numberText(snapshot.excludedPeerCount))} 项 · 待补证 ${escape(numberText(snapshot.pendingPeerCount))} 项（原始报价与复核记录均已保留）</p>` : ''}
    ${snapshot.isBareGoods ? `<p class="hero-stat-sub muted">${escape(BARE_GOODS_DISCLOSURE_ZH)}</p>` : ''}
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

function r58ContactSheetFigure(presentation, label, prefix, imagePool) {
  const sheet = imageUri(presentation?.contact_sheet_data_uri);
  if (!sheet) return '';
  const caption = string(presentation?.contact_sheet_caption, '4×4 类目视觉聚类联系表（用于确认同形态同任务可比集与价位带切分）');
  const altText = string(presentation?.contact_sheet_alt, `${label} 视觉聚类联系表`);
  const zoomId = `${prefix}-sheet-zoom`;
  const mediaHtml = imagePool.renderImage(sheet, { alt: altText, mode: 'contain', lazy: true });
  return `<section class="ledger-section" data-section="contact-sheet">
    <h3>视觉聚类联系表（4×4）</h3>
    <figure class="contact-sheet-frame">
      <a class="zoom-trigger" href="#${zoomId}" aria-label="放大查看 ${escape(label)} 视觉聚类联系表">
        ${mediaHtml}
      </a>
      <figcaption><span>${escape(caption)}</span><a class="zoom-hint" href="#${zoomId}">全屏高清检视</a></figcaption>
    </figure>
    <div id="${zoomId}" class="css-lightbox" role="dialog" aria-label="${escape(label)} 视觉聚类联系表全屏大图">
      <a class="lb-backdrop" href="#${prefix}" aria-label="关闭大图"></a>
      <div class="lb-sheet">
        <div class="lb-head"><strong>${escape(label)} · 视觉聚类联系表（4×4）</strong><a class="lb-close" href="#${prefix}">关闭返回</a></div>
        ${mediaHtml}
      </div>
    </div>
  </section>`;
}

function r58ReferenceImageFigure(presentation, label, prefix, imagePool) {
  const image = imageUri(presentation?.image_data_uri);
  if (!image) return '';
  const altText = string(presentation?.image_alt, `${label} 原始参考与核验存证`);
  const caption = string(presentation?.image_caption, '所附参考与报价核验截图，供核对具体规格');
  const zoomId = `${prefix}-img-zoom`;
  const mediaHtml = imagePool.renderImage(image, { alt: altText, mode: 'contain', lazy: true });
  return `<section class="ledger-section">
    <h3>实物规格与货源原始截图</h3>
    <figure class="contact-sheet-frame">
      <a class="zoom-trigger" href="#${zoomId}" aria-label="放大查看 ${escape(label)} 原始核验图">
        ${mediaHtml}
      </a>
      <figcaption><span>${escape(caption)}</span><a class="zoom-hint" href="#${zoomId}">全屏高清检视</a></figcaption>
    </figure>
    <div id="${zoomId}" class="css-lightbox" role="dialog" aria-label="${escape(label)} 原始核验大图">
      <a class="lb-backdrop" href="#${prefix}" aria-label="关闭大图"></a>
      <div class="lb-sheet">
        <div class="lb-head"><strong>${escape(label)} · 原始核验截图</strong><a class="lb-close" href="#${prefix}">关闭返回</a></div>
        ${mediaHtml}
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
  return unifyFactoryInquiryLabel(r58PolishRangeCopy(string(value)).replace(/—/g, '–'));
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

function resolveR58EvidenceReview(result, original) {
  const raw = result?.evidence_review ?? original?.evidence_review ?? original?.presentation?.evidence_review;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function resolveR58ConceptImages(result, original) {
  const raw = result?.concept_images ?? original?.concept_images ?? original?.presentation?.concept_images;
  return Array.isArray(raw) ? raw : [];
}

const SHAREABLE_PII_KEY_RE = /^(?:(?:recipient|receiver|contact|consignee|buyer|customer|registrant)(?:_?name)?|(?:ship(?:ping)?|delivery|street|home|contact)_?address|phone|phone_number|mobile|tel|telephone)$/i;
const SHAREABLE_REVIEWER_KEY_RE = /^(?:reviewer|reviewer_name|author|auditor|operator)$/i;
const SAFE_SYSTEM_REVIEWER_RE = /^(?:gpt-[0-9a-z.-]+|codex(?:\s+cli)?|claude-(?:3|4|sonnet|opus|haiku)[0-9a-z.-]*|gemini-[0-9a-z.-]+|terra|luna|astra|system|automated|synthetic\s+test\s+double)(?:\s*·\s*[0-9a-z_-]+)?$/i;

function redactShareableReviewTree(value, parentKey = '') {
  const normKey = String(parentKey || '').trim();
  if (SHAREABLE_PII_KEY_RE.test(normKey) && typeof value === 'string' && value.trim()) {
    return '[REDACTED_PII]';
  }
  if (SHAREABLE_REVIEWER_KEY_RE.test(normKey) && typeof value === 'string' && value.trim()) {
    return SAFE_SYSTEM_REVIEWER_RE.test(value.trim()) ? value : '[REDACTED_PII]';
  }
  if (typeof value === 'string') {
    const preScrubbed = redactRawEmails(value)
      .replace(/(?:\+?1[-.\s]?)?\(\d{3}\)\s*\d{3}[-.\s]\d{4}\b/g, '[REDACTED_PHONE]')
      .replace(/(?:\+1[-.\s]|\b(?:tel|telephone|phone|mobile|cell|fax)\s*[:=]?\s*\+?1?[-.\s]?)\b[2-9]\d{2}[-.\s]\d{3}[-.\s]\d{4}\b/gi, '[REDACTED_PHONE]')
      .replace(/(?<![A-Za-z0-9.])(?:\+\d{1,3}[-.\s]?(?:\(\d{1,4}\)[-.\s]?)?(?:\d[-.\s]?){6,13}\d|\b(?:tel|telephone|phone|mobile|cell|fax)\s*[:=]?\s*\+?\d[\d\s().-]{6,18}\d)(?!(?:\.\d|[A-Za-z0-9]))/gi, '[REDACTED_PHONE]')
      .replace(/(?<![A-Za-z0-9.])(?:\+?1[-.\s]?)?[2-9]\d{2}[.-]\d{3}[.-]\d{4}(?!(?:\.\d|[A-Za-z0-9]))/g, '[REDACTED_PHONE]')
      .replace(/\b((?:contact|recipient|receiver|registrant|consignee|buyer|customer)(?:[\s_]+name)?|attn|ship\s*to)\s*[:=]\s*[^\r\n;；|]+/gi, '$1:[REDACTED_NAME]')
      .replace(/\b([Rr]egistrant|REGISTRANT)\s+[A-Z][A-Za-z.'-]+(?:,\s*[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}|(?:\s+[A-Z][A-Za-z.'-]+){0,3})/g, '$1 [REDACTED_NAME]')
      .replace(/(收件人|联系人|注册人)\s*[:：]\s*[^\r\n;；|]+/g, '$1:[REDACTED_NAME]')
      .replace(/\b(address|street\s*address|ship(?:ping)?\s*address)\s*[:=]\s*[^\r\n;；|]+/gi, '$1:[REDACTED_ADDRESS]')
      .replace(/\b\d{1,6}(?:-[A-Za-z0-9]{1,4})?\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9][A-Za-z0-9.\-\s]{0,35}\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Parkway|Pkwy|Circle|Cir|Terrace|Ter|Highway|Hwy)\b\.?(?:\s*,?\s*(?:Suite|Ste\.?|Apt\.?|Unit|#)\s*[A-Za-z0-9-]+)?(?:\s*,\s*[A-Za-z.\s]{2,25}\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/gi, '[REDACTED_ADDRESS]')
      .replace(/(收货地址|联系地址|详细地址)\s*[:：]\s*[^\r\n;；]+/g, '$1:[REDACTED_ADDRESS]');
    return sanitizeDiagnosticText(preScrubbed);
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

function renderR58EvidenceReview(result, original, reportOptions = {}, rev = 59) {
  const raw = resolveR58EvidenceReview(result, original);
  const eligibleForCurrentSpecReview = rev >= 59 && isCandidateEligible(result, rev);
  if (!raw) {
    if (!eligibleForCurrentSpecReview) return '';
    return `<section class="quiet-surface rt-audit" data-section="evidence-review" aria-label="独立红队复核">
    <div class="section-head rt-head">
      <h3>独立红队复核 · Red-Team Audit</h3>
      <span class="muted">顾问式证据复核 · 不改动 21 项计分</span>
    </div>
    <div class="rt-meta-row">
      <span class="state-inline state-pending"><i class="dot" aria-hidden="true"></i>业务入围、当前规格待复核</span>
    </div>
  </section>`;
  }
  const sanitizedPaths = sanitizeDisplayTree(raw);
  const ev = redactShareableReviewTree(sanitizedPaths);
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
  const modelAllowedForRender = ev.model === null || ev.model === undefined ||
    /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(string(ev.model).trim());
  const effortAllowedForRender = ev.reasoning_effort === null || ev.reasoning_effort === undefined || effortName === 'default' ||
    ['xhigh', 'max'].includes(effortName);
  const isCommissionedAstra = modelAllowedForRender && effortAllowedForRender;

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
  } else if (statusKey === 'pending_current_spec_review') {
    statusInfo = { tone: 'pending', text: '业务入围、当前规格待复核' };
  } else if (rawStatus === '未启用' || ['disabled', 'not_submitted', 'off', 'unavailable', 'skipped'].includes(statusKey)) {
    statusInfo = eligibleForCurrentSpecReview
      ? { tone: 'pending', text: '业务入围、当前规格待复核' }
      : { tone: 'muted', text: '未启用' };
  } else if (isValidatedReviewedEnvelope) {
    statusInfo = isStaleSpecReview
      ? { tone: 'pending', text: eligibleForCurrentSpecReview ? '已复核 · 基于旧版参数复核（业务入围、当前规格待复核）' : '已复核 · 基于旧版参数复核' }
      : (rev >= 59 && hasOpenAuditItems
          ? { tone: 'pending', text: '已复核 · 含待定／冲突项' }
          : { tone: 'pass', text: '已复核' });
  } else if (['failed_known', 'rejected', 'invalid', 'refused', 'error'].includes(statusKey)) {
    statusInfo = eligibleForCurrentSpecReview
      ? { tone: 'pending', text: '业务入围、当前规格待复核' }
      : { tone: 'fail', text: '未启用' };
  } else if (eligibleForCurrentSpecReview) {
    statusInfo = { tone: 'pending', text: '业务入围、当前规格待复核' };
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

function renderR58ConceptPlinth(result, original, cardLabel, prefix, imagePool) {
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
        const mediaHtml = imagePool.renderImage(item.data_uri, { alt: altText, mode: 'contain', lazy: true });
        return `<figure class="concept-plinth-card">
          <a class="zoom-trigger concept-plinth-stage" href="#${zoomId}" aria-label="放大查看 ${escape(titleText)}">
            ${mediaHtml}
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
            ${mediaHtml}
            <p class="lb-caption muted">${escape(captionText)}</p>
          </div>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

function r59PriceBandBannersAndObservationBar(original, rev = 59) {
  if (!original || typeof original !== 'object') return '';
  const pb = object(original.price_band_analysis);
  const refPrice = object(original?.screening?.reference_price_usd);
  const pres = object(original?.presentation);
  const mktObs = object(original?.market_observation);

  const isAllYoungBlueOcean = Boolean(
    pb.all_young_niche === true ||
    pb.mature_regular_band?.all_under_90d_blue_ocean === true ||
    refPrice.all_young_niche === true ||
    refPrice.all_under_90d_blue_ocean === true ||
    pb.top_amber_banner ||
    pb.mature_regular_band?.top_amber_banner_zh,
  );
  const rawBanner = pb.top_amber_banner ?? pb.mature_regular_band?.top_amber_banner_zh ?? '';
  const bannerText = typeof rawBanner === 'string' && rawBanner.trim()
    ? rawBanner.trim()
    : '全员 90 天内新品蓝海，暂无一年期老品稳态价';
  const rawGrowthNote = pb.mature_regular_band?.growth_supplement_used === true
    ? (pb.mature_regular_band?.source_note ?? pb.mature_regular_band?.label_zh ?? '')
    : '';
  const growthNote = typeof rawGrowthNote === 'string' ? rawGrowthNote : '';

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

  const isConditionalPostCoupon = Boolean(
    pb.mature_regular_band?.conditional_post_coupon_observation === true ||
    pb.mature_regular_band?.heavy_coupon_excluded === false ||
    pb.conditional_post_coupon_observation === true ||
    pb.heavy_coupon_excluded === false,
  );
  const rawSingleParentNote =
    pb.mature_regular_band?.single_parent_anchor_note_zh ??
    pb.mature_regular_band?.high_price_single_parent_anchor?.note_zh ??
    pb.single_parent_anchor_note_zh ??
    pb.high_price_single_parent_anchor?.note_zh ??
    '';
  const singleParentNote = typeof rawSingleParentNote === 'string' && rawSingleParentNote.trim()
    ? scrubShareableText(rawSingleParentNote)
    : '';

  let html = '';
  if (isAllYoungBlueOcean) {
    const bannerSuffix = isConditionalPostCoupon
      ? '当前按未剔除大额券的条件性在售净价留痕观察，不冒充剔除大额券后的稳态常规价，不阻断评估。'
      : '已按剔除 ≥20% 大额券后的在售常规价核算参考账，不阻断评估。';
    html += `<section class="quiet-surface" data-section="ultra-new-blue-ocean-banner" aria-label="超新蓝海提醒">
      <p><span class="state-inline state-pending"><i class="dot" aria-hidden="true"></i><strong>${escape(scrubShareableText(bannerText))}</strong></span> · <span class="muted">${bannerSuffix}</span></p>
    </section>`;
  } else if (growthNote) {
    html += `<section class="quiet-surface" data-section="growth-tier-supplement-note" aria-label="成长期补位说明">
      <p class="muted"><strong>三档顺位补位说明：</strong>${escape(sanitizeTextPaths(growthNote))}</p>
    </section>`;
  }
  if (singleParentNote) {
    html += `<section class="quiet-surface" data-section="single-parent-anchor-warning" aria-label="高价锚点单父体提醒">
      <p class="muted"><strong>高价锚点集中度提醒：</strong>${escape(singleParentNote)}</p>
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

function r59SamplePendingBanner(snapshot, rev = 59) {
  if (!Array.isArray(snapshot?.sampleCheckItems) || snapshot.sampleCheckItems.length === 0) return '';
  return `<section class="quiet-surface" data-section="sample-pending-checklist" aria-label="拿样与 1688 问厂待核清单">
    <div class="section-head">
      <h3><span class="state-inline state-pending"><i class="dot" aria-hidden="true"></i>拿样／1688 问厂待核清单</span></h3>
      <span class="num"><strong>已得分 ${escape(rangeText(snapshot.supportedRange))} / 已覆盖总权重 ${escape(numberText(snapshot.coveredWeight))}</strong></span>
    </div>
    <ul class="brief-list">${snapshot.sampleCheckItems.map(it =>
      `<li><strong>${escape(string(it.label ?? it.id))}（${escape(numberText(it.weight))} 分留空）</strong> · <span>${escape(r58CleanCopy(string(it.reason)))}</span></li>`
    ).join('')}</ul>
  </section>`;
}

const STAGE5_RETURN_CATEGORY_LABELS = Object.freeze({
  listing_expectation_gap: '页面预期不符',
  assembly_or_usage_confusion: '安装／使用误解',
  packaging_or_transit_damage: '运输破损／包装不足',
  sizing_or_fit_mismatch: '尺寸／适配不合',
  manufacturing_or_structural_defect: '制造失误／结构性缺陷',
  missing_or_wrong_parts: '缺件／错件',
});

const STAGE5_MISSING_FLAG_LABELS = Object.freeze({
  missing_qa_body_text: '缺可核 Q&A 正文',
  missing_sku_matched_review_text: '缺可核同变体原文',
  review_counts_only_no_text: '仅有评论总数、缺可核原文',
  unverified_variant_attribution: '评论未核实对应目标变体',
});

const STAGE5_INQUIRY_SLOT_LABELS = Object.freeze({
  1: '规格配件',
  2: '100/300 套发深圳报价交期',
  3: '零售包装与外箱',
  4: '退货隐患核查',
  5: '拿样待核缺口',
});

const STAGE5_COPY_BLOCK_CSS = '.copy-block{margin:0.6rem 0 0;padding:0.85rem 1rem;background:var(--surface,#fafaf8);border:1px solid var(--hairline);font-family:var(--sans);font-size:0.875rem;line-height:1.68;white-space:pre-wrap;word-break:break-word;user-select:all;color:var(--ink)}';

function resolveR59ReturnCauseDiagnosis(result, original) {
  const raw = result?.return_cause_diagnosis ?? original?.return_cause_diagnosis ?? original?.presentation?.return_cause_diagnosis;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.contract !== 'ReturnCauseDiagnosis') return null;
  if (!['verified_variant_quotes', 'partial_or_unverified_variant', 'insufficient_evidence'].includes(raw.evidence_status)) return null;
  const cardFormId = string(result?.candidate_id ?? original?.id).trim();
  const diagFormId = string(raw.form_id).trim();
  if (!diagFormId || (cardFormId && diagFormId !== cardFormId)) return null;
  return raw;
}

function resolveR59FactoryInquiryChecklist(result, original) {
  const raw = result?.factory_inquiry_1688 ?? original?.factory_inquiry_1688 ?? original?.presentation?.factory_inquiry_1688;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.contract !== 'FactoryInquiryChecklist1688') return null;
  if (raw.auto_send_prohibited !== true) return null;
  const cardFormId = string(result?.candidate_id ?? original?.id).trim();
  const checklistFormId = string(raw.form_id).trim();
  if (!checklistFormId || (cardFormId && checklistFormId !== cardFormId)) return null;
  const structured = array(raw.structured_items).filter(it => it && typeof it === 'object');
  const rawQuestions = array(raw.wangwang_questions).filter(q => typeof q === 'string' && q.trim());
  const bulletCount = structured.length > 0 ? structured.length : rawQuestions.length;
  if (bulletCount !== 5) return null;
  return raw;
}

function r59ReturnCauseDiagnosisSection(result, original, rev = 59) {
  if (!(rev >= 59)) return '';
  const diag = resolveR59ReturnCauseDiagnosis(result, original);
  if (!diag) return '';

  const statusInfo = diag.evidence_status === 'verified_variant_quotes'
    ? { tone: 'pass', text: '已核同变体原文' }
    : diag.evidence_status === 'partial_or_unverified_variant'
      ? { tone: 'pending', text: '部分或未核实变体' }
      : { tone: 'muted', text: '原文证据不足' };

  const rawFlags = array(diag.missing_evidence_flags).filter(f => typeof f === 'string' && f.trim());
  const rawNotes = array(diag.missing_evidence_notes_zh).filter(n => typeof n === 'string' && n.trim());
  const flagTexts = rawFlags.map(f => STAGE5_MISSING_FLAG_LABELS[f] ?? scrubShareableText(f)).filter(Boolean);
  const noteTexts = rawNotes.map(n => scrubShareableText(n)).filter(Boolean);
  const missingTexts = [...flagTexts];
  for (const note of noteTexts) {
    if (!missingTexts.some(existing => existing === note)) {
      missingTexts.push(note);
    }
  }
  const missingHtml = missingTexts.length > 0
    ? `<p class="muted"><strong>证据缺口披露：</strong>${missingTexts.map(t => escape(t)).join('；')}</p>`
    : '';

  const causes = array(diag.causes).filter(c => c && typeof c === 'object' && !Array.isArray(c));
  const causesHtml = causes.length > 0
    ? `<ul class="brief-list">${causes.map(cause => {
        const actInfo = cause.actionability === 'structural_defect_trap'
          ? { tone: 'fail', text: '结构性缺陷陷阱' }
          : cause.actionability === 'fixable_listing_manual_packaging'
            ? { tone: 'pass', text: '可优化（页面／说明书／包装）' }
            : { tone: 'pending', text: '待 1688 问厂核实' };
        const claimLabel = cause.claim_basis === 'explicit_buyer_return'
          ? '买家明言退货'
          : '买家抱怨／可能导致退货';
        const catLabel = STAGE5_RETURN_CATEGORY_LABELS[cause.category] ?? scrubShareableText(string(cause.category, '问题归类'));
        const summary = scrubShareableText(string(cause.summary_zh));
        const specNote = scrubShareableText(string(cause.purchased_spec_note));
        const counterNote = scrubShareableText(string(cause.counter_evidence_zh));
        const hookNote = scrubShareableText(string(cause.factory_verification_hook_zh));
        const cits = array(cause.citations).filter(c => c && typeof c === 'object');
        const citLines = cits.map(c => {
          const srcTag = c.source_type === 'qa'
            ? 'Q&A'
            : (finite(c.stars) ? `${numberText(c.stars)}★` : '低星评');
          const skuTag = scrubShareableText(string(c.variant_sku));
          const verTag = c.sku_verified === true ? '已核同变体' : (c.sku_verified === false ? '非目标或未核实变体' : '变体归属未知');
          const quote = scrubShareableText(string(c.excerpt));
          return `<p class="muted"><span class="mono-id">[${escape(srcTag)}${skuTag ? ` · ${escape(skuTag)}` : ''} · ${escape(verTag)}]</span> “${escape(quote)}”</p>`;
        }).join('');
        return `<li><div><span class="state-inline state-${actInfo.tone}"><i class="dot" aria-hidden="true"></i>${escape(actInfo.text)}</span> · <strong>${escape(catLabel)}</strong> · <span class="muted">${escape(claimLabel)}</span></div>${summary ? `<p>${escape(summary)}</p>` : ''}${specNote ? `<p class="muted">购买规格：${escape(specNote)}</p>` : ''}${citLines}${counterNote ? `<p class="muted">反例与边界：${escape(counterNote)}</p>` : ''}${hookNote ? `<p class="muted">1688 问厂核查点：${escape(hookNote)}</p>` : ''}</li>`;
      }).join('')}</ul>`
    : '';

  const execSummary = scrubShareableText(string(diag.summary_zh));
  const disclaimer = scrubShareableText(string(diag.disclaimer_zh, '仅基于抽查原文诊断，不从差评反推退款率，不改动 21 项评分与 30% 毛利筛线。'));
  const targetSku = scrubShareableText(string(diag.target_variant_sku));

  return `<section class="quiet-surface" data-section="return-cause-diagnosis" aria-label="退货与差评成因诊断">
    <div class="section-head">
      <h3>退货与差评成因诊断（不改动 21 项评分）</h3>
      <span class="state-inline state-${statusInfo.tone}"><i class="dot" aria-hidden="true"></i>${escape(statusInfo.text)}${targetSku ? ` · ${escape(targetSku)}` : ''}</span>
    </div>
    ${missingHtml}
    ${execSummary ? `<p>${escape(execSummary)}</p>` : ''}
    ${causesHtml}
    <p class="muted">${escape(disclaimer)}</p>
  </section>`;
}

function r59FactoryInquiryChecklistSection(result, original, rev = 59) {
  if (!(rev >= 59)) return '';
  const checklist = resolveR59FactoryInquiryChecklist(result, original);
  if (!checklist) return '';

  const structured = array(checklist.structured_items).filter(it => it && typeof it === 'object');
  const rawQuestions = array(checklist.wangwang_questions).filter(q => typeof q === 'string' && q.trim());
  const bullets = structured.length === 5
    ? structured.map((it, idx) => ({
        slot: Number.isInteger(it.slot) ? it.slot : idx + 1,
        label: STAGE5_INQUIRY_SLOT_LABELS[it.slot] ?? `第 ${idx + 1} 条`,
        text: scrubShareableText(string(it.question_zh || rawQuestions[idx])),
        compression: it.includes_package_compression_check === true,
      })).filter(b => b.text)
    : rawQuestions.map((q, idx) => ({
        slot: idx + 1,
        label: STAGE5_INQUIRY_SLOT_LABELS[idx + 1] ?? `第 ${idx + 1} 条`,
        text: scrubShareableText(q),
        compression: false,
      })).filter(b => b.text);
  if (bullets.length !== 5) return '';

  const modeLabel = checklist.generation_mode === 'owner_on_demand_pending'
    ? '主人点选按需生成'
    : '入围卡自动生成';
  // Single copy-block SSOT: always derive plain-text copy block directly from the 5 validated bullets.
  const copyText = bullets.map((b, idx) => `${idx + 1}. ${b.text}`).join('\n');
  const handoffNote = scrubShareableText(string(checklist.manual_handoff_note_zh, '仅限主人审看后手动复制发给 1688 工厂，AI 严禁代发消息。'));

  return `<section class="quiet-surface" data-section="factory-inquiry-1688" aria-label="1688 问厂与拿样 5 条清单">
    <div class="section-head">
      <h3>1688 问厂与拿样 5 条清单</h3>
      <span class="muted">${escape(modeLabel)} · 仅限人工复制发送 · AI 严禁代发消息</span>
    </div>
    <ol class="brief-list">${bullets.map(b =>
      `<li><strong>${escape(b.label)}${b.compression ? '（含 ≤10 mm 压线减尺寸核查）' : ''}：</strong><span>${escape(b.text)}</span></li>`
    ).join('')}</ol>
    <details class="quiet-fold" open><summary>一键复制发厂话术（纯文本 · 人工审看后手动粘贴发送）</summary><pre class="copy-block">${escape(copyText)}</pre></details>
    <p class="muted">${escape(handoffNote)}</p>
  </section>`;
}

function r59CoreAndRemainingSection(snapshot, rev = 59) {
  if (!snapshot) return '';
  const hasCore = Array.isArray(snapshot.core85Range);
  const rem = snapshot.remaining15Summary && typeof snapshot.remaining15Summary === 'object'
    ? snapshot.remaining15Summary
    : null;
  const q4Note = snapshot.unpublished2027Q4PeakNote;
  const isEvergreen = snapshot.productSeasonality === 'evergreen';
  if (!hasCore && !rem && !q4Note && !isEvergreen) return '';
  const sampleIds = new Set(array(snapshot.sampleCheckItems).map(it => it?.id).filter(Boolean));
  const scoredRem = array(rem?.scored_items);
  const extraPendingRem = array(rem?.pending_items).filter(it => !sampleIds.has(it?.id));
  const parts = [];
  if (isEvergreen || q4Note) {
    parts.push(`<p class="muted coverage-line" data-meta="evergreen-seasonality"><strong>归类与旺季说明：</strong>${isEvergreen ? '常青品（非季节款）' : '在评款式'}${q4Note ? ` · ${escape(r58CleanCopy(q4Note))}` : ''}</p>`);
  }
  if (hasCore || rem) {
    const coreTxt = hasCore ? `<strong>85 分客观核心：${escape(rangeText(snapshot.core85Range))} / 85</strong>` : '';
    const remTxt = rem
      ? `剩余 15 分已证得分 ${escape(rangeText(rem.supported_range))} / ${escape(numberText(rem.covered_weight))}（已确认风险扣分 ${escape(numberText(rem.confirmed_risk_deduction))} 分）`
      : '';
    parts.push(`<p class="coverage-line" data-meta="core-85-summary">${[coreTxt, escape(remTxt)].filter(Boolean).join(' · ')}</p>`);
  }
  if (scoredRem.length > 0 || extraPendingRem.length > 0) {
    const rows = [
      ...scoredRem.map(it =>
        `<li><strong>${escape(string(it.label ?? it.id))}（已得 ${escape(rangeText(it.score_range))} / ${escape(numberText(it.weight))} 分）</strong>${it.reason ? ` · <span>${escape(r58CleanCopy(reasonText(it.reason)))}</span>` : ''}</li>`
      ),
      ...extraPendingRem.map(it =>
        `<li><strong>${escape(string(it.label ?? it.id))}（${escape(numberText(it.weight))} 分待核）</strong> · <span>${escape(r58CleanCopy(reasonText(it.reason)))}</span></li>`
      ),
    ];
    parts.push(`<details class="quiet-fold" data-section="remaining-15-breakdown"><summary>剩余 15 分已证项与待核原因明细（已证 ${scoredRem.length} 项${extraPendingRem.length > 0 ? ` · 待核 ${extraPendingRem.length} 项` : ''}）</summary><ul class="brief-list">${rows.join('')}</ul></details>`);
  }
  return parts.join('');
}

function r59CompetitionReferenceBar(original, rev = 59) {
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
    const tone = medRev < 100 ? 'pass' : medRev <= 500 ? 'pending' : 'fail';
    const word = medRev < 100 ? '绿 · 低门槛' : medRev <= 500 ? '黄 · 中等门槛' : '红 · 高评论壁垒';
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

function r58PeriodPanel(period, presentation, registry, prefix, panelIndex, rev = 59, original = null) {
  const isCrossingR59 = rev >= 59 && period?.diagnostics?.economics?.crossing_margin_floor === true;
  const hasSamplePendingPeriodR59 = rev >= 59 && Array.isArray(period?.sample_check_items) && period.sample_check_items.length > 0;
  const complete = Array.isArray(period.total_range) && (period.queue === 'comparable' || isCrossingR59);
  const gaps = array(period.items).filter(item => item.status === 'needs_evidence');
  const ineligible = array(period.items).filter(item => item.status === 'ineligible');
  const conditions = array(period.screening?.conditions).filter(condition => condition.status !== 'pass');
  const economics = object(period.diagnostics?.economics);
  const periodScenarios = array(economics.scenarios).filter(isActivePricingScenario);
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

function r59CalibrationSummarySection(original, rev = 59) {
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

function r58SeasonalCard(result, original, index, rev = 59, reportOptions = {}, imagePool) {
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const displays = array(presentation.operating_periods);
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  const periods = array(result.operating_periods);
  const eligible = isCandidateEligible(result, rev);
  const snapshot = extractMetricsSnapshot(result, rev, original);
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
        ${r59CoreAndRemainingSection(snapshot, rev)}${r59PriceBandBannersAndObservationBar(original, rev)}${r59SamplePendingBanner(snapshot, rev)}${r59ReturnCauseDiagnosisSection(result, original, rev)}${r59FactoryInquiryChecklistSection(result, original, rev)}${hasBrief ? `<section class="quiet-surface brief-grid" aria-label="关键风险与核查清单">
          ${r57BriefList('风险与边界提示', presentation.risks, rev)}
          ${r57BriefList('后续核查事项', presentation.next_checks, rev)}
          ${blockers.length ? `<div class="brief-col"><h3>共同问题与后续处理</h3><ul class="brief-list">${blockers.map(row => `<li><strong>${escape(rev >= 59 ? unifyFactoryInquiryLabel(row.problem) : row.problem)}</strong>${typeof row.next_step === 'string' ? `<p class="muted">下一步：${escape(rev >= 59 ? unifyFactoryInquiryLabel(row.next_step) : row.next_step)}</p>` : ''}</li>`).join('')}</ul></div>` : ''}
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
              ${r58ContactSheetFigure(presentation, cardLabel, prefix, imagePool)}
              ${r58ReferenceImageFigure(presentation, cardLabel, prefix, imagePool)}
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
        </div>${renderR58ConceptPlinth(result, original, cardLabel, prefix, imagePool)}
      </div>
    </div>
  </article>`;
}

function r58SingleCard(result, original, index, rev = 59, reportOptions = {}, imagePool) {
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
  const snapshot = extractMetricsSnapshot(result, rev, original);
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
          <span class="muted queue-tag">${rev >= 59 && snapshot.productSeasonality === 'evergreen' ? `常青款 · ${hasSamplePendingSingleR59 ? '入围（含拿样待核）' : QUEUES[queue]}` : (hasSamplePendingSingleR59 ? '入围（含拿样待核）' : QUEUES[queue])}</span>
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
        ${r59CoreAndRemainingSection(snapshot, rev)}${r59PriceBandBannersAndObservationBar(original, rev)}${r59SamplePendingBanner(snapshot, rev)}${r59ReturnCauseDiagnosisSection(result, original, rev)}${r59FactoryInquiryChecklistSection(result, original, rev)}${hasBrief ? `<section class="quiet-surface brief-grid" aria-label="关键风险与缺口">
          ${r57BriefList('风险与边界提示', presentation.risks, rev)}
          ${r57BriefList('后续核查事项', presentation.next_checks, rev)}
          ${mainGaps.length ? `<div class="brief-col"><h3>${queue === 'excluded' && gaps.length === 0 ? '排除原因与后续处理' : '需要解决的缺口'}</h3><ul class="brief-list">${mainGaps.map(row => `<li><strong>${escape(rev >= 59 ? unifyFactoryInquiryLabel(row.problem) : row.problem)}</strong>${typeof row.next_step === 'string' ? `<p class="muted">下一步：${escape(rev >= 59 ? unifyFactoryInquiryLabel(row.next_step) : row.next_step)}</p>` : ''}</li>`).join('')}</ul></div>` : ''}
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
              ${r58ContactSheetFigure(presentation, cardLabel, prefix, imagePool)}
              ${r58ReferenceImageFigure(presentation, cardLabel, prefix, imagePool)}
              ${r59CalibrationSummarySection(original, rev)}${r57KeyValueSection('采购参考与规格核对', presentation.procurement)}
              ${r57KeyValueSection('市场范围与新增观察', presentation.market_references)}
              ${r57DiscoveryDetails(original?.discovery, registry, prefix, rev)}
            </section>
            <section class="tab-panel tab-p4 tab-panel-bib">
              <div class="section-head"><h3>来源与适用限制</h3><span class="muted">本地路径已统一脱敏</span></div>
              ${r57Bibliography(registry, prefix)}
            </section>
          </div>
        </div>${renderR58ConceptPlinth(result, original, cardLabel, prefix, imagePool)}
      </div>
    </div>
  </article>`;
}

function renderR58Report(result, batch = {}, reportOptions = {}) {
  const rev = result?.profile_revision ?? 59;
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
  const flatSamplePendingEligibleCount = rev >= 59
    ? candidates.filter(cand => cand?.queue !== 'seasonal_review' && cand?.queue !== 'comparable' && isCandidateEligible(cand, rev)).length
    : 0;
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
  const r58OrderRule = rev >= 59
    ? '所有初选入围卡统一按 85 分客观核心降序排列（同分按剩余 15 分已确认风险扣分升序）；区间重叠不代表严格优劣。'
    : '全年 12 个月完整可比卡优先列于 2–9 月主营淡季达标卡之前；区间重叠不代表严格优劣。';

  const queueLinks = [
    (() => {
      const idx = candidates.findIndex(c => c?.queue === 'comparable' && isCandidateEligible(c, rev));
      return idx >= 0 ? `<a href="#candidate-${idx + 1}">完整可比 ${escape(numberText(completeCount))}</a>` : '';
    })(),
    (() => {
      const idx = flatSamplePendingEligibleCount > 0
        ? candidates.findIndex(c => c?.queue !== 'seasonal_review' && c?.queue !== 'comparable' && isCandidateEligible(c, rev))
        : -1;
      return idx >= 0 ? `<a href="#candidate-${idx + 1}">待拿样入围 ${escape(numberText(flatSamplePendingEligibleCount))}</a>` : '';
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
  const reportSnaps = candidates.map(cand => extractMetricsSnapshot(cand, rev, originals.get(cand?.candidate_id)));
  const anyOver100Report = reportSnaps.some(s => s.orderUnitsRange && s.orderUnitsRange[1] > 100);
  const allBareGoodsReport = reportSnaps.length > 0 && reportSnaps.every(s => s.isBareGoods);
  const anyBareGoodsReport = reportSnaps.some(s => s.isBareGoods);
  const mobileDomesticHeader = allBareGoodsReport
    ? (anyOver100Report ? '1688裸货' : '1688百套裸货')
    : (anyBareGoodsReport ? '1688货价口径' : (anyOver100Report ? '1688到深含运' : null));
  const anyAiSections = candidates.some(cand => {
    const orig = originals.get(cand?.candidate_id);
    return resolveR58EvidenceReview(cand, orig) !== null ||
      (sanitizeR58ConceptImages(resolveR58ConceptImages(cand, orig))?.length ?? 0) > 0;
  });
  const anyStage5CopyBlock = rev >= 59 && candidates.some(cand =>
    resolveR59FactoryInquiryChecklist(cand, originals.get(cand?.candidate_id)) !== null,
  );
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
  const imagePool = createReportImagePool(candidates, originals);
  const dynamicCss = [
    `${Array.from({ length: maxPanels - 5 }, (_, idx) => `.card-tabs:has(input[id$="-t${idx + 6}"]:checked) .tab-p${idx + 6}`).join(',\n')}{\n  display:block;\n}`,
    targetPlinthCss,
    reservedFilterCss,
    mobileDomesticHeader ? `@container (width < 42.5rem){.matrix-table{--m4:"${mobileDomesticHeader}"}}` : '',
    anyAiSections ? R58_AI_SECTIONS_CSS.trim() : '',
    anyStage5CopyBlock ? STAGE5_COPY_BLOCK_CSS : '',
    imagePool.dedupCss(),
  ].filter(Boolean).join('\n');

  const reservedTabHtml = reservedBucketCount > 0
    ? `<label class="tn-tab" for="filter-reserved"><input class="filter-radio" type="radio" name="wb-filter" id="filter-reserved">私模留档 ${escape(numberText(reservedBucketCount))}</label>`
    : '';
  const filterNavHtml = `<label class="tn-tab" for="filter-all"><input class="filter-radio" type="radio" name="wb-filter" id="filter-all" checked>全部 ${escape(numberText(candidates.length))}</label><label class="tn-tab" for="filter-pass"><input class="filter-radio" type="radio" name="wb-filter" id="filter-pass">达标可推进 ${escape(numberText(eligibleCount))}</label><label class="tn-tab" for="filter-pending"><input class="filter-radio" type="radio" name="wb-filter" id="filter-pending">待补证 ${escape(numberText(pendingBucketCount))}</label>${reservedTabHtml}<label class="tn-tab" for="filter-hold"><input class="filter-radio" type="radio" name="wb-filter" id="filter-hold">淘汰／暂缓 ${escape(numberText(holdCount))}</label><a class="tn-tab" href="#overview">横向比对</a><label class="tn-tab" for="expand-qualifiers"><input class="mode-check" type="checkbox" id="expand-qualifiers">口径说明</label>`;

  const flatSamplePendingHeadline = flatSamplePendingEligibleCount > 0
    ? `，平铺待拿样入围 ${escape(numberText(flatSamplePendingEligibleCount))} 个`
    : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="text-scale" content="scale"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>${R58_FONT_FACE_CSS}${R58_STUDIO_CSS}\n${dynamicCss}</style></head><body><a class="skip-link" href="#cards">跳到候选卡</a>${imagePool.defsSpriteHtml()}<main class="studio-page"><header class="masthead"><div class="mh-left"><h1>${escape(title)}</h1><p class="mh-colophon"><span class="mh-en">US FBA Product Curation · 2027 Fee Architecture · Rev ${escape(result?.profile_revision ?? 59)}</span>${typeof presentation.summary === 'string' ? `<span class="mh-sep">／</span><span>${escape(presentation.summary)}</span>` : ''}</p><p class="batch-counts">本轮 ${escape(numberText(candidates.length))} 个候选；完整可比 ${escape(numberText(completeCount))} 个${flatSamplePendingHeadline}，${headlinePendingText}。${seasonalCounts}${r58OrderRule}</p></div>${candidates.length ? `<div class="mh-right" role="region" aria-label="筛选与视图控制"><div class="typo-nav" role="radiogroup" aria-label="候选筛选">${filterNavHtml}</div>${queueLinks ? `<nav class="queue-nav" aria-label="跳转候选队列">${queueLinks}</nav>` : ''}</div>` : ''}</header>${renderR58ExhibitionReel(candidates, originals, rev, imagePool)}<p class="filter-empty muted">当前筛选条件下暂无候选款式，请切换至“全部”查看完整展列。</p><section id="cards" aria-label="候选产品深度精算展台">${candidates.length ? candidates.map((candidate, index) => (candidate?.queue === 'seasonal_review' ? r58SeasonalCard(object(candidate), originals.get(candidate?.candidate_id), index, rev, reportOptions, imagePool) : r58SingleCard(object(candidate), originals.get(candidate?.candidate_id), index, rev, reportOptions, imagePool))).join('') : '<div class="empty-state"><h2>本轮没有候选卡</h2><p class="muted">保留发现与覆盖记录；没有候选不等于市场中没有机会。</p></div>'}</section>${renderComparisonMatrix(candidates, originals, rev)}${r59PackagingRedesignAppendix(result, batch, rev)}${r57BatchContext(presentation)}<footer class="report-footer"><p>评分反映本轮证据与已确认试评规则。未知不按零计，不把已知部分折算为100分；初步评分、供应验证、主人决定与实际经营效果分别核验。</p><p>规则版本：修订 ${escape(result?.profile_revision ?? '未知')} · 离线单文件零外部请求</p></footer></main></body></html>`;
}

export function renderReport(result, batch = {}, reportOptions = {}) {
  return renderR58Report(result, batch, reportOptions);
}
