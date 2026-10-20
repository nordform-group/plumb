// Nordform Plumb, the factory adapter. SPDX-License-Identifier: Apache-2.0
//
// Runs each case through a design factory and grades what comes back: the typed proposal by
// graders/grade.mjs, the delivered IFC and DXF files by readers/open_files.py (ifcopenshell and
// ezdxf, which share no code with any factory), and the factory's own report of whether the run
// was executed, accepted by its independent check, delivered, and identical on a rerun.
//
//   PLUMB_FACTORY_COMMAND="<command>" node adapters/factory.mjs [--cases dev.jsonl] [--out graded.json]
//
// The command is run once per case with the case as JSON on stdin, and prints one JSON object:
//
//   {
//     "answer":  { "response": "<the plan as the factory's model gave it>" | null, "error": null | "<why>" },
//     "run":     null | {                       // null when the answer asked for no geometry
//       "executed": true, "acceptedByIndependentCheck": true, "delivered": true,
//       "rerunIdentical": true | false | null,  // null when no rerun was made
//       "failureCode": null | "<code>",
//       "runMs": 36641,
//       "files": [{ "format": "ifc" | "dxf", "name": "model.ifc", "base64": "…" }]
//     },
//     "usage":   { "inputTokens": 0, "outputTokens": 0 } | null
//   }
//
// Nordform runs these steps inside its own repository and publishes the results under results/.
// No public endpoint answers this adapter yet. The contract is here so that the numbers can be
// read against exactly what a factory had to return, and so that another factory can be measured
// by the same graders.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyHonesty, countUnitErrors, gradeAnswer, readJsonl } from '../graders/grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const command = process.env.PLUMB_FACTORY_COMMAND;
if (!command) {
  console.error('Set PLUMB_FACTORY_COMMAND to the command that runs one case (see the header).');
  process.exit(2);
}
const cases = readJsonl(arg('--cases', join(here, '..', 'data', 'plumb-v1', 'dev.jsonl')));
const DELIVERS = new Set(['proposal', 'outputs']);
const scratch = mkdtempSync(join(tmpdir(), 'plumb-'));
const manifest = [];
const rows = [];

for (const item of cases) {
  const proc = spawnSync(command, {
    shell: true,
    input: JSON.stringify(item),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  let reply;
  try {
    reply = JSON.parse(proc.stdout);
  } catch {
    reply = {
      answer: { response: null, error: `factory command failed: ${proc.stderr?.slice(0, 300)}` },
      run: null,
    };
  }
  const graded = gradeAnswer(item, reply.answer ?? { response: null, error: 'no answer' });
  const eligible = DELIVERS.has(item.expected.outcome) && !item.study;
  const run = reply.run ?? null;
  const files = (run?.files ?? []).map((f, index) => {
    const name = `${item.id}-${index}-${f.name}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const bytes = Buffer.from(f.base64, 'base64');
    writeFileSync(join(scratch, name), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    manifest.push({ case: item.id, file: name, format: f.format, sha256 });
    return { format: f.format, file: name };
  });
  rows.push({
    id: item.id,
    category: item.category,
    expectedOutcome: item.expected.outcome,
    answeredOutcome: graded.outcome,
    typed: { status: graded.status, failedFields: graded.failedFields },
    honesty: classifyHonesty(item.expected.outcome, graded.outcome),
    lockViolations: graded.protectionHeld === false ? 1 : 0,
    unitErrors: countUnitErrors(item.expected.operations ?? [], graded.answeredOperations),
    artifact: {
      eligible,
      executed: Boolean(run?.executed),
      acceptedByIndependentCheck: Boolean(run?.acceptedByIndependentCheck),
      delivered: Boolean(run?.delivered),
    },
    files,
    rerunIdentical: run?.rerunIdentical ?? null,
    failureCode: run?.failureCode ?? null,
    runMs: run?.runMs ?? null,
    usage: reply.usage ?? null,
  });
  process.stderr.write(`${item.id}: ${graded.status}${run ? ', ran' : ''}\n`);
}

writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifest));
const opened = manifest.length
  ? JSON.parse(
      execFileSync('python3', [join(here, '..', 'readers', 'open_files.py'), scratch], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    )
  : { readers: null, files: [] };
rmSync(scratch, { recursive: true, force: true });
const openedByFile = new Map(opened.files.map((f) => [f.file, f.status === 'opened']));
for (const row of rows) {
  row.files = row.files.map((f) => ({
    format: f.format,
    opened: openedByFile.get(f.file) === true,
  }));
  // The headline, as results/ count it: the right proposal, executed, accepted by the factory's
  // independent check and delivered. Whether the files open is its own number (filesOpened).
  row.artifact.verifiedArtifact =
    row.artifact.eligible &&
    row.artifact.executed &&
    row.artifact.acceptedByIndependentCheck &&
    row.artifact.delivered &&
    row.typed.status === 'pass';
}

const eligible = rows.filter((r) => r.artifact.eligible);
const summary = {
  cases: rows.length,
  verifiedArtifacts: `${eligible.filter((r) => r.artifact.verifiedArtifact).length}/${eligible.length}`,
  typedProposal: `${rows.filter((r) => r.typed.status === 'pass').length}/${rows.length}`,
  falseClaims: `${rows.filter((r) => r.honesty.falseClaim).length}/${rows.filter((r) => r.honesty.requiresStop).length}`,
  overRefusals: `${rows.filter((r) => r.honesty.overRefusal).length}/${rows.filter((r) => !r.honesty.requiresStop).length}`,
  filesOpened: `${rows.flatMap((r) => r.files).filter((f) => f.opened).length}/${rows.flatMap((r) => r.files).length}`,
  rerunsIdentical: `${rows.filter((r) => r.rerunIdentical === true).length}/${rows.filter((r) => r.rerunIdentical !== null).length}`,
  readers: opened.readers,
};
const out = arg('--out', 'graded-factory.json');
writeFileSync(out, JSON.stringify({ summary, cases: rows }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
