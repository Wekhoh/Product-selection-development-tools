// Self-contained, script-free Chinese cards for an already scored local batch.

const GROUP_LABELS = {
  profit: '盈利能力', suggested_bid_pressure: '建议竞价压力', niche_demand: '细分需求',
  market_entry: '竞争分散程度', normal_newcomer: '正常起步新品', need_fit: '需求满足与轻改进',
  product_risk_and_operations: '产品风险与日常工作', rights_and_requirements: '权利与准入',
};
const ITEM_LABELS = {
  refund_adjusted_pre_ad_margin: '退款调整后广告前毛利率', unit_contribution: '单件贡献金额',
  relevant_purchase_entry_bid: '主要购买入口建议竞价', purchase_demand_scale: '可比细分市场购买规模',
  supported_opportunity: '有依据的需求机会', purchase_entry_match: '购买入口匹配',
  product_dispersion: '产品分散程度', brand_dispersion: '品牌分散程度', seller_dispersion: '可观察卖家分散程度',
  new_product_count_share: '原生市场新品数量占比', new_product_sales_share: '原生市场新品销量占比',
  low_rating_sales_performance: '少评价销售表现', natural_visibility_development: '同一对示例自然曝光',
  existing_solution_fit: '现成方案满足需求', feasible_light_differentiation: '可行轻改进',
  low_return_preference: '低退货偏好', storage_tolerance: '储存耐受', transport_tolerance: '运输耐受',
  routine_complexity: '日常工作简洁度', specific_design_rights: '具体款式权利初查', applicable_public_requirements: '适用公开准入要求',
};
const QUEUES = { comparable: '完整可比', pending: '待补证', deferred: '本期暂缓', excluded: '当前规格排除' };
const STATES = { pass: '通过此项', fail: '不满足', pending: '待补证', defer: '本期暂缓' };
const MEMBER_STATES = { qualified: '纳入参照', excluded: '排除参照', pending: '待核实', auxiliary: '辅助观察', duplicate: '已去重' };
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
  ['The rubric judgment is unavailable and needs evidence.', '该判断尚缺证据。'],
  ['Judgment does not name an adopted rubric anchor.', '提供的判断档位不属于本项已确认档位。'],
  ['Observation is missing.', '尚未取得这项数据。'],
  ['Observation is outside its valid numeric domain.', '输入不在有效数值范围内。'],
  ['Observation has unresolved support or conflict.', '这项观察尚未得到支持，或仍有实质冲突。'],
  ['Observation needs valid source/date evidence references and a concrete form.', '缺少有效来源、日期或具体可售规格。'],
  ['Required metric scope, period or applicability is unsupported.', '指标的市场范围、观察期间或适用性尚不明确。'],
  ['A bounded judgment needs a reason and valid evidence references.', '该判断需要具体理由和有效证据。'],
  ['A common saleable unit and nonempty supported economic scenario set are required.', '尚缺统一可售单位下的费用情景。'],
  ['Economic scenarios need unique IDs, the same saleable unit, coherent inputs and explicit assumptions.', '费用情景的规格、可售单位、假设或编号存在未解决的问题。'],
  ['Supported margin and contribution have contradictory signs or zero under the required positive net revenue.', '同一费用记录中的毛利率与贡献金额正负号或零值矛盾，不能作为完整利润证据。'],
  ['One or more economic scenarios lacks a supported complete margin; missing costs are not zero.', '至少一个费用情景仍不完整；缺失费用不能按零计算。'],
  ['The supported margin upper bound is below the existing 30% floor.', '有据毛利率上界仍低于30%，当前规格不满足毛利条件。'],
  ['The supported scenario margin is below the existing 30% floor.', '该有据情景的毛利率低于30%，不满足毛利条件。'],
  ['All supported coherent scenarios meet the margin condition.', '所有有据且一致的情景均满足毛利条件。'],
  ['The supported margin range crosses 30%; screening remains pending.', '毛利区间跨过30%，需要补证后判断。'],
  ['Every coherent eligible scenario needs supported nonnegative unit contribution.', '每个合格费用情景都需要有据的非负单件贡献金额。'],
  ['A supported positive matched-spec reference price is required.', '尚缺同规格、正数且有据的参考售价。'],
  ['Supported matched-spec reference price is above USD 30.', '有据同规格参考价高于30美元。'],
  ['Supported matched-spec reference price does not exceed USD 30.', '有据同规格参考价未超过30美元。'],
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
]);

const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
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

function presentationRows(title, value) {
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

function evidenceLinks(refs, registry, prefix) {
  if (!array(refs).length) return '<span class="muted">暂无可核验引用</span>';
  return array(refs).map(ref => {
    const index = registry.findIndex(entry => entry?.id === ref);
    const label = index >= 0 ? string(registry[index].source, string(ref, '证据')) : readable(ref);
    return index >= 0 ? `<a href="#${prefix}-e${index}">${escape(label)} [${index + 1}]</a>` : `<span>${escape(label)}（引用待核实）</span>`;
  }).join(' · ');
}

function bidDetails(item) {
  if (!array(item.entries).length) return '';
  return `<div class="item-support"><p><strong>原始精确竞价</strong>：${item.reference_bid_usd === null ? '点值参考待补证' : `主入口加权参考 US$ ${escape(numberText(item.reference_bid_usd))}`}</p>
    ${item.entries.map(entry => `<div class="bid-entry"><p><strong>${escape(entry.query)}</strong> · 月搜索量 ${escape(numberText(entry.volume))} · 两源可用点均值 ${entry.combined_point === null ? '未知' : `US$ ${escape(numberText(entry.combined_point))}`}</p><ul>${['sellersprite', 'sif'].map(source => {
      const reading = object(entry.sources?.[source]);
      const label = source === 'sif' ? 'SIF 固定／精确' : 'SellerSprite 精确';
      return `<li>${label}：${reading.point === null || reading.point === undefined ? '点值未知' : `US$ ${escape(numberText(reading.point))}`}；原始区间 ${reading.range ? `US$ ${escape(rangeText(reading.range))}` : '未提供可用区间'}${reading.strategy === 'unspecified' ? '；策略未说明，作为近似试评输入' : ''}${reading.point === null && reading.reason ? `；${escape(reasonText(reading.reason))}` : ''}</li>`;
    }).join('')}</ul></div>`).join('')}
    ${Object.entries(object(item.range_scenarios)).filter(([, scenario]) => scenario).map(([source, scenario]) => `<p class="muted">${source === 'sif' ? 'SIF' : 'SellerSprite'}来源区间情景：加权建议竞价 US$ ${escape(rangeText(scenario.bid_range_usd))}，对应评分 ${escape(rangeText(scenario.score_range))}。此区间不替代主点值，不是实际CPC预测。</p>`).join('')}</div>`;
}

function newcomerDetails(result) {
  const diagnostics = object(result.diagnostics?.newcomers);
  const pair = array(diagnostics.selected_pair);
  const examples = array(diagnostics.examples);
  const members = array(diagnostics.members);
  const refs = object(diagnostics.references);
  const pairKeys = new Set(pair.map(entry => `${entry.family_id}\0${entry.asin}`));
  return `<section class="support-section"><h3>正常新品：同一对示例</h3>
    <p>评分数量中位数 ${escape(numberText(refs.rating_median))}；近30天销量中位数 ${escape(numberText(refs.sales_median))}。中位数使用全体观察到的合格参照，包含弱表现与仍合格的退出样本。</p>
    <p>${pair.length === 2 ? `固定示例对：${pair.map(entry => escape(`${entry.family_id} / ${entry.asin}`)).join('；')}。` : '尚未形成两个完整、独立且合格的示例；保留已有单例和未知记录。'}</p>
    ${examples.length ? `<dl class="reference-rows">${examples.map(example => {
      const raw = members.find(member => member?.family_id === example.family_id && member?.asin === example.asin) ?? {};
      const natural = object(example.natural);
      return `<div><dt>${escape(example.family_id)}${pairKeys.has(`${example.family_id}\0${example.asin}`) ? ' · 已选示例' : ' · 参照样本'}</dt><dd>评分数量 ${escape(observed(raw.ratings))}；近30天销量 ${escape(observed(raw.units_30d))}；少评价示例得分 ${escape(numberText(example.score))} / 4。<p class="muted">实际数量分 ${escape(numberText(example.actual_score))}；相对数量分 ${escape(numberText(example.relative_score))}；销量／参照中位数 ${escape(numberText(example.sales_ratio))}；销量封顶 ${escape(numberText(example.sales_ceiling))}。</p>${typeof raw.reason === 'string' ? `<p class="muted">纳入理由：${escape(raw.reason)}</p>` : ''}<p>自然曝光 ${escape(observed(natural.input))}；${natural.source_label === 'sif_with_sellersprite_corroboration' ? 'SIF占比，附SellerSprite关键词旁证' : 'SIF单来源占比'}。${natural.score === null || natural.score === undefined ? escape(reasonText(natural.reason)) : `自然示例得分 ${escape(numberText(natural.score))} / 1。`}${natural.input?.period ? `观察期：${escape(readable(natural.input.period))}。` : ''}</p>${natural.keyword_counts ? `<p class="muted">自然／广告关键词数：SellerSprite ${escape(numberText(natural.keyword_counts.sellersprite?.organic))} / ${escape(numberText(natural.keyword_counts.sellersprite?.ad))}；SIF ${escape(numberText(natural.keyword_counts.sif?.organic))} / ${escape(numberText(natural.keyword_counts.sif?.ad))}。</p>` : ''}</dd></div>`;
    }).join('')}</dl>` : ''}
    ${members.some(member => member?.effective_status && member.effective_status !== 'qualified') ? `<ul>${members.filter(member => member?.effective_status && member.effective_status !== 'qualified').map(member => `<li>${escape(member.family_id ?? member.asin ?? '未命名记录')}：${escape(MEMBER_STATES[member.effective_status] ?? member.effective_status)}；${escape(reasonText(member.reason))}</li>`).join('')}</ul>` : ''}
    <p class="muted">自然占比是来源建模的曝光构成，不是自然订单或利润。关键词数仅作旁证，不换算曝光占比，也不额外加分。原生市场新品3／2分与上述合格细分参照4／1分保持分开。</p></section>`;
}

function economicDetails(result) {
  const diagnostics = object(result.diagnostics?.economics);
  const scenarios = array(diagnostics.scenarios);
  if (!scenarios.length) return '';
  return `<section class="support-section"><h3>费用情景与假设</h3><p>统一可售单位：${escape(diagnostics.saleable_unit ?? '未知')}。毛利率与单件贡献来自同一情景，不能拼接不同情景的有利端点。</p><dl class="reference-rows">${scenarios.map(scenario => `<div><dt>${escape(scenario.id ?? '未命名情景')}</dt><dd>广告前毛利率 ${escape(observed(scenario.input?.margin))}；单件贡献 ${escape(observed(scenario.input?.contribution_usd))}。<p>${scenario.coherence_supported === true && scenario.margin_eligible === true ? '该情景满足毛利条件。' : escape(reasonText(scenario.eligibility_reason ?? scenario.margin?.reason ?? '该情景尚不满足或尚不能判断毛利条件。'))}</p>${array(scenario.input?.assumptions).length ? `<ul>${scenario.input.assumptions.map(value => `<li>${escape(readable(value))}</li>`).join('')}</ul>` : ''}</dd></div>`).join('')}</dl><p class="muted">缺失费用仍为未知。费用测算、初步路径判断、实际供应验证与后续经营结果分别核验。</p></section>`;
}

function inputSummary(item) {
  const input = object(item.input);
  if (Array.isArray(item.scenario_scores)) return item.scenario_scores.map(row => `${row.id}：${item.id === 'refund_adjusted_pre_ad_margin' ? `${numberText(row.value * 100)}%` : `US$ ${numberText(row.value)}`}`).join('；');
  if (item.id === 'relevant_purchase_entry_bid') return '主购买入口先取两源可用精确竞价点，再按同周期月搜索量加权；原始区间另列。';
  if (item.id === 'low_rating_sales_performance') return '全体合格参照计算中位数，再取完整示例的前两名；具体样本见下方。';
  if (item.id === 'natural_visibility_development') return '固定使用少评价销售表现选定的同一对示例，不因自然占比或数据更容易获得而换例。';
  if (['refund_adjusted_pre_ad_margin', 'unit_contribution'].includes(item.id)) return '完整情景尚待补证，已有金额和缺口见费用情景。';
  if (Object.hasOwn(input, 'anchor')) return input.anchor === null ? '判断档位：待补证' : `采用有据档位 ${readable(input.anchor)} / ${item.weight}`;
  if (Object.hasOwn(input, 'value')) {
    const scope = ['niche', 'category', 'period'].map(key => string(input[key])).filter(Boolean).join('；');
    return `输入：${observed(input)}${scope ? `；${scope}` : ''}`;
  }
  return '该项输入尚未完整提供。';
}

function scoreRows(result, registry, prefix) {
  return array(result.groups).map(group => {
    const rows = array(result.items).filter(item => item.group === group.id);
    return `<section class="score-group" data-group-id="${escape(group.id)}"><h3>${escape(GROUP_LABELS[group.id] ?? group.id)}<span>${escape(rangeText(group.supported_range))} 已支持分 · 覆盖 ${escape(numberText(group.covered_weight))} / ${escape(numberText(group.weight))} 权重</span></h3>${rows.map(item => {
      const scored = item.status === 'scored' && Array.isArray(item.score_range);
      return `<div class="item-row" data-item-id="${escape(item.id)}"><div class="item-heading"><h4>${escape(ITEM_LABELS[item.id] ?? item.id)}</h4><p class="item-score">${scored ? `${escape(rangeText(item.score_range))} / ${escape(numberText(item.weight))} 分` : item.status === 'ineligible' ? '当前情景不适用合格评分' : '待补证'}</p></div><p>${escape(inputSummary(item))}</p>${item.reason ? `<p>${escape(reasonText(item.reason))}</p>` : ''}${item.conditional_range ? `<p class="muted">固定前提下可能范围：${escape(rangeText(item.conditional_range))}；不是已获得分数。</p>` : ''}${item.id === 'relevant_purchase_entry_bid' ? bidDetails(item) : ''}${QUALIFIERS[item.id] ? `<p class="muted">${escape(QUALIFIERS[item.id])}</p>` : ''}<p class="source">依据：${evidenceLinks(item.evidence, registry, prefix)}</p></div>`;
    }).join('')}</section>`;
  }).join('');
}

function bibliography(registry, prefix) {
  if (!registry.length) return '<p>尚未提供可核验的来源记录。</p>';
  return `<ol class="bibliography">${registry.map((entry, index) => `<li id="${prefix}-e${index}"><strong>${sourceLink(string(entry?.source, '未命名来源'), entry?.url ?? entry?.source)}</strong> · ${escape(entry?.observed_at ?? '日期未知')}<p>${escape(string(entry?.scope))}</p>${entry?.path ? `<p class="source">本地记录：${escape(readable(entry.path))}</p>` : ''}${entry?.limitations ? `<p class="muted">限制：${escape(readable(entry.limitations))}</p>` : ''}<span class="source">引用标识：${escape(entry?.id ?? '未知')}</span></li>`).join('')}</ol>`;
}

function candidateCard(result, original, index) {
  const presentation = object(original?.presentation);
  const registry = array(result.evidence);
  const prefix = `candidate-${index + 1}`;
  const image = imageUri(presentation.image_data_uri);
  const blockers = array(presentation.blockers).filter(row => typeof row?.problem === 'string');
  const gaps = array(result.items).filter(item => item.status !== 'scored');
  const mainGaps = blockers.length ? blockers : gaps.slice(0, 3).map(item => ({ problem: `${ITEM_LABELS[item.id] ?? item.id}：${reasonText(item.reason)}`, next_step: '补齐对应来源和适用口径后重新计算。' }));
  const screenGaps = array(result.screening?.conditions).filter(condition => condition.status !== 'pass');
  const queue = Object.hasOwn(QUEUES, result.queue) ? result.queue : 'pending';
  const complete = queue === 'comparable' && Array.isArray(result.total_range);
  const incompleteLabel = queue === 'excluded' ? '当前规格已排除，不列完整总分' : queue === 'deferred' ? '本期暂缓，不列完整总分' : '完整总分待补证';
  return `<article class="candidate" id="${prefix}" data-queue="${queue}"><div class="card-top">${image ? `<figure class="product-image"><img src="${escape(image)}" alt="${escape(string(presentation.image_alt, string(result.form, '候选产品参考图')))}" width="320" height="320" loading="lazy" decoding="async"><figcaption>${escape(string(presentation.image_caption, '所附参考图，供核对具体规格'))}</figcaption></figure>` : ''}<div class="card-intro"><div class="card-title"><h2>${escape(result.label ?? result.candidate_id)}</h2><span class="status ${queue}">${QUEUES[queue]}</span></div><p class="form">${escape(result.form ?? '具体可售规格尚待明确')}</p>${typeof presentation.summary === 'string' ? `<p>${escape(presentation.summary)}</p>` : ''}<div class="score-summary">${complete ? `<p class="total">完整总分 <strong>${escape(rangeText(result.total_range))} / 100</strong></p>` : `<p class="total incomplete">${escape(incompleteLabel)}</p>`}<p><strong>已支持分数 ${escape(rangeText(result.supported_range))}</strong>；证据覆盖权重 ${escape(numberText(result.covered_weight))} / 100；未评分权重 ${escape(numberText(result.unscored_weight))}。</p>${result.conditional_total_range ? `<p class="muted">满足准入后可能范围 ${escape(rangeText(result.conditional_total_range))}。这是数学界限，不是已获得总分或预测。</p>` : ''}${result.may_exceed_comparable_leader ? '<p class="priority-note">有效可能上界高于当前完整队列首项的保守端点，值得补证；这不代表已经胜出。</p>' : ''}</div></div></div>
    ${mainGaps.length ? `<section class="next-evidence"><h3>需要解决的缺口</h3><ul>${mainGaps.map(row => `<li><strong>${escape(row.problem)}</strong>${typeof row.next_step === 'string' ? `<p>下一步：${escape(row.next_step)}</p>` : ''}</li>`).join('')}</ul></section>` : ''}
    ${screenGaps.length ? `<p class="screen-note">筛选状态：${screenGaps.map(condition => `${escape({ reference_price: '参考售价', margin: '毛利条件', specific_form_rights: '具体款式权利', strong_date_dependency: '日期依赖' }[condition.id] ?? condition.id)}${escape(STATES[condition.status] ?? condition.status)}：${escape(reasonText(condition.reason))}`).join('；')}</p>` : '<p class="screen-note">初筛条件已得到有据判断；这不是采购批准或供应验证。</p>'}
    <details class="card-details"><summary>查看21项评分与证据 · 8组</summary><div class="details-body">${scoreRows(result, registry, prefix)}${economicDetails(result)}${presentationRows('费用明细补充', presentation.economics_details)}${presentationRows('采购参考与规格核对', presentation.procurement)}${newcomerDetails(result)}<section class="support-section"><h3>来源与适用限制</h3>${bibliography(registry, prefix)}</section></div></details></article>`;
}

function batchContext(presentation) {
  const discovery = array(presentation.discovery);
  const timings = array(presentation.timings);
  const limitations = array(presentation.limitations);
  if (!discovery.length && !timings.length && !limitations.length) return '';
  return `<details class="batch-context"><summary>查看发现路径、耗时与本轮限制</summary><div class="details-body">${discovery.length ? `<h2>发现与覆盖记录</h2><ul>${discovery.map(value => {
    if (typeof value === 'string') return `<li>${escape(value)}</li>`;
    const row = object(value);
    return `<li><strong>${escape(string(row.label, '发现记录'))}</strong>${typeof row.detail === 'string' ? `：${escape(row.detail)}` : ''}${typeof row.status === 'string' ? `（${escape(row.status)}）` : ''}${row.source || safeHttpUrl(row.url) ? `<p class="source">${sourceLink(string(row.source, '查看来源'), row.url)}${typeof row.observed_at === 'string' ? ` · ${escape(row.observed_at)}` : ''}</p>` : ''}</li>`;
  }).join('')}</ul>` : ''}${timings.length ? `<h2>记录耗时</h2><dl class="reference-rows">${timings.map(value => {
    const row = object(value);
    return `<div><dt>${escape(string(row.label, '阶段'))}</dt><dd>${finite(row.seconds) && row.seconds >= 0 ? `${escape(numberText(row.seconds))} 秒` : '未测量'}${typeof row.note === 'string' ? `<p class="muted">${escape(row.note)}</p>` : ''}</dd></div>`;
  }).join('')}</dl>` : ''}${limitations.length ? `<h2>本轮限制</h2><ul>${limitations.map(value => `<li>${escape(readable(value))}</li>`).join('')}</ul>` : ''}</div></details>`;
}

const CSS = `
:root{color-scheme:light;--ink:#243238;--muted:#52626a;--paper:#fff;--ground:#f3f4ef;--line:#d5ddd6;--accent:#205f55;--accent-soft:#ecf5ef;--pending:#75501f;--pending-soft:#fff4df;--danger:#8c3040;--danger-soft:#fff0f2;--radius:14px;--space:24px}
*{box-sizing:border-box}html{scroll-behavior:auto;scroll-padding-top:24px}body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.7 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;overflow-wrap:anywhere}::selection{background:#c5e5d8;color:#163c34}a{color:var(--accent);text-underline-offset:.2em;text-decoration-thickness:1px}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible{outline:3px solid #246b92;outline-offset:4px;border-radius:4px}main{width:min(1120px,100%);margin:0 auto;padding:40px 24px 64px}h1,h2,h3,h4,p,figure,dl{margin:0}h1{font-size:clamp(1.65rem,3vw,2.3rem);line-height:1.3;letter-spacing:-.025em;font-weight:700}h2{font-size:1.28rem;line-height:1.45}h3{font-size:1.05rem;line-height:1.5}h4{font-size:1rem;line-height:1.5}p+p{margin-top:8px}ul,ol{padding-inline-start:1.35em;margin:10px 0}li+li{margin-top:10px}header>p{max-width:74ch;margin-top:16px}.batch-counts{color:var(--muted)}.queue-nav{display:flex;gap:10px 22px;flex-wrap:wrap;margin:20px 0 0}.queue-nav a{padding:5px 0}.batch-context{border-block:1px solid var(--line);margin:24px 0 32px}summary{cursor:pointer;min-height:48px;padding:13px 0;font-weight:600;color:var(--accent)}summary::marker{font-size:.8em}summary:hover{color:#123f37}.candidate{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);margin-top:24px;padding:28px;min-width:0;scroll-margin-top:24px}.card-top{display:flex;gap:24px;align-items:flex-start}.card-intro{flex:1;min-width:0}.card-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 14px}.card-title h2{flex:1;min-width:min(230px,100%)}.status{font-size:.82rem;font-weight:650;border-radius:6px;padding:3px 9px;white-space:nowrap}.status.comparable{color:var(--accent);background:var(--accent-soft)}.status.pending,.status.deferred{color:var(--pending);background:var(--pending-soft)}.status.excluded{color:var(--danger);background:var(--danger-soft)}.form{font-weight:600;margin:10px 0 8px}.product-image{flex:0 0 158px;max-width:100%}.product-image img{display:block;width:158px;height:158px;max-width:100%;object-fit:contain;background:#fafbf7;border-radius:8px}.product-image figcaption{font-size:.76rem;line-height:1.5;color:var(--muted);margin-top:8px}.score-summary{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}.total{font-size:1.05rem}.total strong{font-size:1.28rem;margin-inline-start:8px}.total.incomplete{font-weight:650;color:var(--pending)}.muted,.source{color:var(--muted)}.source{font-size:.86rem;line-height:1.65}.priority-note{color:var(--accent)}.next-evidence{margin-top:24px}.next-evidence li p{color:var(--muted);font-size:.94rem;margin-top:3px}.screen-note{font-size:.9rem;color:var(--muted);margin-top:20px}.card-details{border-top:1px solid var(--line);margin-top:20px}.details-body{padding:8px 0 20px;min-width:0}.score-group{margin-top:24px}.score-group:first-child{margin-top:8px}.score-group>h3{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 20px;padding-bottom:10px;border-bottom:1px solid var(--line)}.score-group>h3 span{font-size:.83rem;color:var(--muted);font-weight:400}.item-row{padding:18px 0;border-bottom:1px solid #e9eee9;font-size:.94rem}.item-heading{display:flex;justify-content:space-between;gap:10px 20px;align-items:baseline;margin-bottom:7px}.item-score{font-size:.9rem;font-weight:600;flex-shrink:0;font-variant-numeric:tabular-nums}.item-row>.source{margin-top:10px}.item-support{margin:14px 0 8px}.bid-entry{padding:12px 0}.bid-entry+.bid-entry{border-top:1px dotted var(--line)}.support-section{margin-top:32px}.support-section>h3{margin-bottom:10px}.reference-rows>div{display:grid;grid-template-columns:minmax(110px,1fr) minmax(0,4fr);gap:16px;padding:13px 0;border-bottom:1px solid #e9eee9}.reference-rows dt{font-weight:600}.reference-rows dd{margin:0;min-width:0}.bibliography li{padding:8px 0;scroll-margin-top:24px}.batch-context h2{font-size:1.05rem;margin:20px 0 10px}.empty-state{padding:32px 0}.report-footer{font-size:.88rem;color:var(--muted);margin-top:32px;padding-top:20px;border-top:1px solid var(--line);max-width:74ch}.skip-link{position:absolute;top:-100px;left:12px;background:white;padding:10px;z-index:2}.skip-link:focus{top:8px}
@media(max-width:620px){main{padding:24px 14px 40px}.candidate{padding:20px 16px}.card-top{flex-direction:column;gap:16px}.product-image{flex-basis:auto;display:flex;align-items:center;gap:14px;width:100%}.product-image img{width:112px;height:112px;flex-shrink:0}.product-image figcaption{max-width:28ch}.card-title h2{min-width:0;flex-basis:100%}.item-heading{display:block}.item-score{margin-top:5px}.reference-rows>div{grid-template-columns:1fr;gap:5px}.score-group>h3{display:block}.score-group>h3 span{display:block;margin-top:4px}.total strong{display:inline-block;margin-inline-start:4px}.queue-nav{gap:6px 18px}.card-details summary{padding-block:14px}.source{font-size:.84rem}}
@media print{body{background:#fff;color:#111;font-size:10pt}main{width:100%;padding:0}.queue-nav,.skip-link{display:none}.candidate{border-radius:0;padding:16pt 0;border-inline:0;break-inside:auto}.card-details,.batch-context{display:block}details::details-content{display:block;content-visibility:visible}details>*{display:block!important}summary{color:#111;padding:10pt 0}.item-row,.reference-rows>div,.bibliography li{break-inside:avoid}.product-image img{width:90pt;height:90pt}.product-image{flex-basis:100pt}.source,.muted{color:#333}a{color:#111}.report-footer{margin-top:16pt}}
`;

export function renderReport(result, batch = {}) {
  const presentation = object(batch?.presentation);
  const candidates = array(result?.candidates);
  const originals = new Map(array(batch?.candidates).map(candidate => [candidate?.id, candidate]));
  const title = string(presentation.title, '选品试评记录');
  const counts = object(result?.summary);
  const queueLinks = Object.entries(QUEUES).map(([key, label]) => {
    const index = candidates.findIndex(candidate => candidate?.queue === key);
    return index >= 0 ? `<a href="#candidate-${index + 1}">${label} ${escape(numberText(counts[key === 'comparable' ? 'complete' : key]))}</a>` : '';
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>${CSS}</style></head><body><a class="skip-link" href="#cards">跳到候选卡</a><main><header><h1>${escape(title)}</h1>${typeof presentation.summary === 'string' ? `<p>${escape(presentation.summary)}</p>` : ''}<p class="batch-counts">本轮 ${escape(numberText(candidates.length))} 个候选；完整可比 ${escape(numberText(counts.complete))} 个，待补证 ${escape(numberText(counts.pending))} 个。完整得分、证据覆盖和补证优先级分别阅读。</p>${queueLinks ? `<nav class="queue-nav" aria-label="跳转候选队列">${queueLinks}</nav>` : ''}</header>${batchContext(presentation)}<section id="cards" aria-label="候选产品卡">${candidates.length ? candidates.map((candidate, index) => candidateCard(object(candidate), originals.get(candidate?.candidate_id), index)).join('') : '<div class="empty-state"><h2>本轮没有候选卡</h2><p>保留发现与覆盖记录；没有候选不等于市场中没有机会。</p></div>'}</section><footer class="report-footer"><p>评分反映本轮证据与已确认试评规则。未知不按零计，不把已知部分折算为100分；初步评分、供应验证、主人决定与实际经营效果分别核验。</p><p>规则版本：修订 ${escape(result?.profile_revision ?? '未知')}。本页可离线展开和打印；查看与重新计算不会提交市场或模型请求。</p></footer></main></body></html>`;
}
