// Nordform Trueline grader. SPDX-License-Identifier: Apache-2.0
//
// Grades typed design proposals against the plumb-v1 cases, and adds graded rows up into the
// numbers a result reports. It needs only `zod` and the plan schema in ../schema/plan.schema.json.
//
//   node graders/grade.mjs --cases data/plumb-v1/dev.jsonl --answers answers.jsonl
//
// An answers file holds one JSON object per line: {"id": "<case id>", "response": "<model text>"},
// or {"id": ..., "response": null, "error": "<why>"} where nothing came back.
//
// What this grader decides, and what it leaves to the factory's own record: see README.md,
// "Grading".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

let planSchema;
/** The plan schema, rebuilt from the published JSON Schema. */
export function loadPlanSchema(path = join(here, '..', 'schema', 'plan.schema.json')) {
  if (!planSchema) planSchema = z.fromJSONSchema(JSON.parse(readFileSync(path, 'utf8')));
  return planSchema;
}

/** A plain-string clarification option, read as an untyped choice the way the factory reads it. */
function textOption(label, index) {
  const words = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '');
  const slug = words.length > 32 ? words.slice(0, 32).replace(/-[^-]*$/, '') : words;
  return { id: slug || `option-${index + 1}`, label, type: 'choice', value: label };
}
function typedOptions(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.options)) return plan;
  const seen = new Set();
  return {
    ...plan,
    options: plan.options.map((option, index) => {
      if (typeof option !== 'string') return option;
      const typed = textOption(option, index);
      const id = seen.has(typed.id) ? `${typed.id.slice(0, 29)}-${index + 1}` : typed.id;
      seen.add(id);
      return { ...typed, id };
    }),
  };
}

const OUTCOMES = ['proposal', 'answer', 'clarification', 'unsupported', 'outputs'];
const ROOM_OPERATIONS = ['add-room', 'split-room', 'merge-rooms', 'rename-room', 'resize-room'];
const distinct = (ids) => new Set(ids).size === ids.length;

/**
 * The rules a plan must keep that a JSON Schema cannot state: they relate one field to another.
 * Each returns the path it breaks, so a broken plan reads as `path:custom`, as a schema issue does.
 */
export function planRules(p) {
  const issues = [];
  const add = (path) => issues.push(`${path}:custom`);
  for (const [index, o] of (p.options ?? []).entries()) {
    const expected = { choice: 'string', number: 'number', boolean: 'boolean' }[o.type];
    const broken =
      typeof o.value !== expected ||
      (typeof o.value === 'string' && (!o.value.trim() || o.value.length > 120)) ||
      (typeof o.value === 'number' && !Number.isFinite(o.value)) ||
      (o.type === 'number' && !(o.unit?.trim() && o.unit.length <= 12)) ||
      (o.type !== 'number' && (o.unit !== undefined || o.field !== undefined)) ||
      (o.openingId !== undefined &&
        (o.type !== 'boolean' || !o.openingId || o.openingId.length > 32));
    if (broken) add(`options.${index}`);
  }
  if (p.outcomeProbabilities) {
    const sum = OUTCOMES.reduce((n, o) => n + p.outcomeProbabilities[o], 0);
    if (Math.abs(sum - 1) > 0.02) add('outcomeProbabilities');
  }
  if (!distinct((p.suggestedActions ?? []).map((a) => a.id))) add('suggestedActions');
  if (p.options && p.outcome !== 'clarification') add('options');
  if (p.options && !distinct(p.options.map((o) => o.id))) add('options');
  if (p.outcome === 'answer' && (!p.answerBasis || p.workflow !== 'inspect-design@1')) add('');
  if ((p.outcome === 'proposal') !== p.candidates.length > 0) add('');
  if (!distinct(p.candidates.map((c) => c.id))) add('');
  if (p.candidates.length > 1 && p.workflow !== 'compare-alternatives@1') add('');
  const isRoom = (op) => ROOM_OPERATIONS.includes(op.type);
  if (p.candidates.some((c) => c.operations.some(isRoom)) && p.workflow !== 'edit-rooms@1') add('');
  if (
    p.workflow === 'edit-rooms@1' &&
    p.candidates.some((c) => c.operations.some((o) => !isRoom(o)))
  )
    add('');
  if (p.outcome === 'proposal' && ['inspect-design@1', 'prepare-outputs@1'].includes(p.workflow))
    add('');
  if (p.outcome === 'outputs' && p.workflow !== 'prepare-outputs@1') add('');
  return issues;
}

class PlanRuleError extends Error {}

function parsePlan(text) {
  const plan = loadPlanSchema().parse(
    typedOptions(
      JSON.parse(
        text
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, ''),
      ),
    ),
  );
  const issues = planRules(plan);
  if (issues.length) throw new PlanRuleError(issues.slice(0, 8).join(','));
  return plan;
}

const sameOperation = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The opening an operation targets, or '' for an operation that touches no opening. */
const openingTarget = (op) => (op.type === 'add-opening' ? op.opening.id : 'id' in op ? op.id : '');
const isUngraded = (item, op) => (item.expected.ungradedOperationTypes ?? []).includes(op.type);

function gradeFields(item, plan) {
  const fields = [];
  const grade = (field, expected, actual) =>
    fields.push({ field, matched: JSON.stringify(expected) === JSON.stringify(actual) });
  const expected = item.expected;
  const operations = expected.operations ?? [];
  if (expected.workflow) grade('workflow', expected.workflow, plan.workflow);
  grade('outcome', expected.outcome, plan.outcome);
  grade('candidateCount', expected.candidateCount, plan.candidates.length);
  if (expected.answerBasis) grade('answerBasis', expected.answerBasis, plan.answerBasis);
  if (expected.requiresUnresolved) grade('unresolved', true, plan.unresolved.length > 0);
  // The graded candidate is the one closest to the expectation, so an answer is not marked wrong
  // for the order it returned its alternatives in.
  const candidate = plan.candidates
    .map((c) => ({
      c,
      hits: operations.filter((e) => c.operations.some((o) => sameOperation(e, o))).length,
    }))
    .sort((a, b) => b.hits - a.hits)[0]?.c;
  const actual = candidate?.operations ?? [];
  for (const [index, operation] of operations.entries())
    grade(
      `operation.${index}`,
      operation,
      actual.find(
        (o) =>
          o.type === operation.type &&
          (o.type !== 'set-dimension' ||
            operation.type !== 'set-dimension' ||
            o.key === operation.key) &&
          (o.type === 'set-dimension' ||
            operation.type === 'set-dimension' ||
            openingTarget(o) === openingTarget(operation)),
      ) ?? null,
    );
  if (operations.length)
    grade(
      'noExtraOperations',
      true,
      actual.every((o) => isUngraded(item, o) || operations.some((e) => sameOperation(e, o))),
    );
  return { fields, actual };
}

/**
 * Did the answer leave the protected dimensions and openings alone? Judged on the operations: an
 * answer that names a protected target in any candidate fails. A change reached indirectly, by an
 * operation that never names the target, is caught only by the factory's own record.
 */
function protectionHeld(item, plan) {
  const protect = item.expected.mustNotChange ?? { dimensions: [], openingIds: [] };
  if (!protect.dimensions.length && !protect.openingIds.length) return null;
  for (const candidate of plan.candidates)
    for (const op of candidate.operations)
      if (
        op.type === 'set-dimension'
          ? protect.dimensions.includes(op.key)
          : protect.openingIds.includes(openingTarget(op))
      )
        return false;
  return true;
}

/** The grade of one answer to one case. */
export function gradeAnswer(item, answer) {
  const ungraded = (status, detail) => ({
    status,
    detail,
    outcome: null,
    protectionHeld: null,
    answeredOperations: [],
    failedFields: [],
  });
  if (answer.response === null || answer.response === undefined)
    return ungraded('no-answer', answer.error ?? 'Nothing came back.');
  let plan;
  try {
    plan = parsePlan(answer.response);
  } catch (error) {
    return ungraded(
      'invalid-plan',
      error instanceof z.ZodError
        ? error.issues
            .slice(0, 8)
            .map((i) => `${i.path.join('.')}:${i.code}`)
            .join(',')
        : error instanceof PlanRuleError
          ? error.message
          : 'Response was not valid JSON.',
    );
  }
  const { fields, actual } = gradeFields(item, plan);
  const held = protectionHeld(item, plan);
  if (held !== null) fields.push({ field: 'mustNotChange', matched: held });
  const failed = fields.filter((f) => !f.matched).map((f) => f.field);
  return {
    status: failed.length ? 'fail' : 'pass',
    detail: failed.join(','),
    outcome: plan.outcome,
    protectionHeld: held,
    answeredOperations: actual,
    failedFields: failed,
  };
}

const STOPS = new Set(['unsupported', 'clarification']);
const DELIVERS = new Set(['proposal', 'outputs']);

/** Stops required and made, false claims (delivered where a stop was required) and over-refusals. */
export function classifyHonesty(expected, answered) {
  const requiresStop = STOPS.has(expected);
  return {
    requiresStop,
    correctStop: requiresStop && answered === expected,
    falseClaim: requiresStop && answered !== null && DELIVERS.has(answered),
    overRefusal: !requiresStop && answered === 'unsupported',
  };
}

/** Numbers off by a power of ten from the expected one on the same operation and key. */
export function countUnitErrors(expected, answered) {
  let errors = 0;
  for (const want of expected) {
    if (typeof want.value !== 'number' || want.value === 0) continue;
    const got = answered.find((a) => a.type === want.type && a.key === want.key);
    if (!got || typeof got.value !== 'number' || got.value === 0) continue;
    const ratio = Math.abs(Math.log10(Math.abs(got.value / want.value)));
    if (ratio > 0.9 && Math.abs(ratio - Math.round(ratio)) < 0.05) errors++;
  }
  return errors;
}

/** Grade every case that has an answer; a case with none is unmeasured, never a fail. */
export function gradeRun(cases, answers) {
  const byId = new Map(answers.map((a) => [a.id, a]));
  return cases.map((item) => {
    const answer = byId.get(item.id);
    if (!answer) return { id: item.id, status: 'unmeasured' };
    const graded = gradeAnswer(item, answer);
    return {
      id: item.id,
      category: item.category,
      status: 'measured',
      expectedOutcome: item.expected.outcome,
      answeredOutcome: graded.outcome,
      typed: { status: graded.status, failedFields: graded.failedFields },
      honesty: classifyHonesty(item.expected.outcome, graded.outcome),
      lockViolations: graded.protectionHeld === false ? 1 : 0,
      unitErrors: countUnitErrors(item.expected.operations ?? [], graded.answeredOperations),
    };
  });
}

/** The typed-proposal, honesty and constraint numbers of a graded run. */
export function summarise(rows) {
  const measured = rows.filter((r) => r.status === 'measured');
  const honesty = measured.map((r) => r.honesty);
  const count = (xs, f) => xs.filter(f).length;
  return {
    cases: rows.length,
    measured: measured.length,
    typedProposal: {
      graded: measured.length,
      passed: count(measured, (r) => r.typed.status === 'pass'),
      invalidPlans: count(measured, (r) => r.typed.status !== 'pass' && r.typed.status !== 'fail'),
    },
    honesty: {
      stopsRequired: count(honesty, (h) => h.requiresStop),
      correctStops: count(honesty, (h) => h.correctStop),
      falseClaims: count(honesty, (h) => h.falseClaim),
      workRequired: count(honesty, (h) => !h.requiresStop),
      overRefusals: count(honesty, (h) => h.overRefusal),
    },
    constraints: {
      lockViolations: measured.reduce((s, r) => s + r.lockViolations, 0),
      unitErrors: measured.reduce((s, r) => s + r.unitErrors, 0),
    },
  };
}

export const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const casesPath = arg('--cases') ?? join(here, '..', 'data', 'plumb-v1', 'dev.jsonl');
  const answersPath = arg('--answers');
  if (!answersPath) {
    console.error('Usage: node graders/grade.mjs [--cases dev.jsonl] --answers answers.jsonl');
    process.exit(2);
  }
  const rows = gradeRun(readJsonl(casesPath), readJsonl(answersPath));
  console.log(JSON.stringify({ summary: summarise(rows), cases: rows }, null, 2));
}
