import { DEFAULT_TERRA_MAX_OUTPUT_TOKENS } from './pricing.mjs';
import { assertNonemptyString } from '../contracts.mjs';

export const DEFAULT_RESPONSES_MODEL = 'gpt-6.1-terra';

export const DETERMINISTIC_MATH_KEYS = Object.freeze([
  'fba_fee',
  'fba_fee_usd',
  'fulfillment_usd',
  'placement_usd',
  'referral_fee_usd',
  'pre_ad_margin',
  'margin',
  'margin_pct',
  'unit_contribution_usd',
  'carton_lcm',
  'order_plan',
  'allocated_sets',
  'actual_sets',
  'actual_complete_sets',
  'goods_cny_total',
  'domestic_freight_cny_total',
  'unit_price_cny',
  'cny_total',
  'rmb_total',
  'landed_domestic_cap_cny',
  'proposed_score',
  'score',
  'scores',
  'item_score',
  'points',
  'earned_points',
  'total_score',
  'covered_weight',
]);

export function validateResponsesModelOptions(options, taskLabel = 'Responses task') {
  const model = options.model ?? DEFAULT_RESPONSES_MODEL;
  const reasoningEffort = options.reasoningEffort ?? 'xhigh';
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_TERRA_MAX_OUTPUT_TOKENS;
  const trimmedModel = assertNonemptyString(model, 'model', { maxLength: 96 });
  if (/astra/i.test(trimmedModel)) {
    throw new TypeError(
      `Model "${trimmedModel}" is blocked on paid OpenAI Responses/Batches; route flagship Astra tasks to local subscription Codex CLI.`,
    );
  }
  if (!['medium', 'high', 'xhigh'].includes(reasoningEffort)) {
    throw new TypeError(`Unsupported reasoningEffort "${String(reasoningEffort)}" for ${taskLabel}.`);
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1024) {
    throw new RangeError('maxOutputTokens must be a safe integer >= 1024.');
  }
  if (reasoningEffort === 'xhigh' && maxOutputTokens < 4096) {
    throw new RangeError('reasoningEffort "xhigh" requires maxOutputTokens >= 4096 so reasoning tokens do not starve JSON output.');
  }
  return { model: trimmedModel, reasoningEffort, maxOutputTokens };
}

export function buildStructuredTaskRequest(settings, {
  instructions, userContent, schemaName, schema, tools = [], maxToolCalls,
}) {
  return {
    model: settings.model,
    reasoning: { effort: settings.reasoningEffort },
    max_output_tokens: settings.maxOutputTokens,
    tools,
    ...(maxToolCalls == null ? {} : { max_tool_calls: maxToolCalls }),
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: instructions.join('\n') }] },
      { role: 'user', content: typeof userContent === 'string' ? [{ type: 'input_text', text: userContent }] : userContent },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        strict: true,
        schema,
      },
    },
  };
}
