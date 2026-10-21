// Nordform Trueline, the model-alone arm. SPDX-License-Identifier: Apache-2.0
//
// Asks a model for the typed proposal each case calls for, with nothing but the case and the plan
// schema: no factory prompt, no catalogue, no kernel, no checks. Writes one answer per line, which
// graders/grade.mjs grades exactly as it grades the factory's answers.
//
//   ANTHROPIC_API_KEY=… node runners/model-alone.mjs [--model claude-opus-5-5] [--cases dev.jsonl] [--out answers.jsonl]
//
// The request matches the one the Nordform run makes for this arm: the system prompt in
// prompts/model-alone-system.txt, the case as JSON in one user turn, a 4,096-token answer budget,
// adaptive thinking at high effort with 16,000 tokens of room for it (none on Haiku 4.5). Cases with
// reference images are skipped and recorded as unmeasured: this arm is not given images in plumb-v1.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const model = arg('--model', 'claude-opus-5-5');
const casesPath = arg('--cases', join(here, '..', 'data', 'plumb-v1', 'dev.jsonl'));
const out = arg('--out', `answers-model-alone-${model}.jsonl`);
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('Set ANTHROPIC_API_KEY.');
  process.exit(2);
}

const system = readFileSync(join(here, '..', 'prompts', 'model-alone-system.txt'), 'utf8');
const manifest = JSON.parse(
  readFileSync(join(here, '..', 'data', 'plumb-v1', 'manifest.json'), 'utf8'),
);
const promptSha256 = createHash('sha256').update(system).digest('hex');
if (promptSha256 !== manifest.modelAlonePrompt.sha256)
  throw Error('prompts/model-alone-system.txt does not match the manifest; it has been changed.');

const thinks = !model.startsWith('claude-haiku-4-5');
const cases = readFileSync(casesPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const lines = [];
for (const item of cases) {
  if (item.references?.length) {
    lines.push({ id: item.id, unmeasured: 'Reference images are not given to this arm.' });
    continue;
  }
  const caseInput = {
    brief: item.brief,
    latestRequest: item.latestRequest,
    current: item.current,
    context: item.context,
    scope: item.scope ?? null,
    kernel: item.kernel,
    packages: item.packages,
    history: item.history,
    ...(item.study ? { study: item.study } : {}),
  };
  const started = Date.now();
  let record;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096 + (thinks ? 16000 : 0),
        system,
        messages: [{ role: 'user', content: JSON.stringify(caseInput) }],
        ...(thinks ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } } : {}),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw Error(`${response.status} ${body?.error?.type ?? ''}`.trim());
    const text = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text);
    record = {
      id: item.id,
      response: body.stop_reason === 'end_turn' && text.length ? text.join('') : null,
      error: body.stop_reason === 'end_turn' ? null : `stop_reason ${body.stop_reason}`,
      usage: body.usage
        ? { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens }
        : null,
    };
  } catch (error) {
    record = { id: item.id, response: null, error: String(error).slice(0, 300), usage: null };
  }
  record.elapsedMs = Date.now() - started;
  lines.push(record);
  process.stderr.write(`${item.id}: ${record.response === null ? 'no answer' : 'answered'}\n`);
}
writeFileSync(
  out,
  lines
    .filter((l) => !l.unmeasured)
    .map((l) => JSON.stringify({ ...l, model, promptSha256 }))
    .join('\n') + '\n',
);
console.log(
  `${out}: ${lines.filter((l) => !l.unmeasured).length} answers, ${lines.filter((l) => l.unmeasured).length} unmeasured. Grade with: node graders/grade.mjs --answers ${out}`,
);
