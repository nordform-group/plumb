# Nordform Trueline

Nordform Trueline is an open benchmark for design factories: systems that take a building brief in
plain language and return a design. It asks a narrow question. When a brief goes through the
factory, how often does a checked, readable design come out? How often does the factory stop when
it should, and refuse nothing it could do? What does that cost, compared with the same model asked
on its own?

Trueline borrows its shape from benchmarks people trust: an open case set, graders anyone can rerun,
named baselines, several measures instead of one score, and dated runs that keep their losses.
Nordform builds a design factory and publishes its own results here, the bad runs included.

The benchmark was published as Nordform Plumb until 21 October 2026. Its first corpus keeps the
identifier `plumb-v1`, and results recorded before the rename keep the old name.

## What is in this repository

| Path                          | What it is                                                                     | Licence    |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------- |
| `data/plumb-v1/dev.jsonl`     | The 44 published cases of corpus plumb-v1, one JSON object per line            | CC BY 4.0  |
| `data/plumb-v1/heldout.json`  | The held-out cases as SHA-256 commitments only (see [The corpus](#the-corpus)) | CC BY 4.0  |
| `data/plumb-v1/manifest.json` | Case counts per flow and split, the split rule, the prompt hash                | CC BY 4.0  |
| `results/`                    | Every dated run, and `history.json`, the list of all of them                   | CC BY 4.0  |
| `schema/plan.schema.json`     | The JSON Schema of a typed design proposal, the answer every case asks for     | Apache-2.0 |
| `prompts/`                    | The system prompt of the model-alone arm                                       | Apache-2.0 |
| `graders/grade.mjs`           | The grader: typed proposal, honesty, locks and units                           | Apache-2.0 |
| `runners/model-alone.mjs`     | Runs the model-alone arm against the Anthropic API                             | Apache-2.0 |
| `adapters/factory.mjs`        | Runs the cases through a factory and grades what it returns                    | Apache-2.0 |
| `readers/open_files.py`       | Opens delivered IFC and DXF files with ifcopenshell and ezdxf                  | Apache-2.0 |

The factory itself is not here. This repository holds what a reader needs to check the numbers:
the cases, the graders, a baseline anyone can rerun, and the contract a factory has to answer.

## The two arms

**Factory.** The brief goes through Nordform's factory as a customer's would. A model reads the
brief and answers with a typed proposal: named operations on named parameters, never geometry or
code. The factory checks the proposal, builds the design from it with deterministic code, runs the
registered checks and writes the delivered IFC and DXF files.

**Model alone.** The same model gets the same case and the plan schema, and nothing else: no
factory prompt, no catalogue, no kernel, no checks. It is graded by the same grader. It cannot make
a design, so its verified-design count is zero by construction. The comparison is in the typed
proposal, honesty and constraints.

## The corpus

plumb-v1 was frozen on 2026-10-20, and every dated run from then on uses it. A changed case means
plumb-v2, never a different plumb-v1. It has three flows:

| Flow                  | Cases | Published | What runs                                                                                   |
| --------------------- | ----- | --------- | ------------------------------------------------------------------------------------------- |
| `planner-to-artifact` | 60    | 44        | A brief and a request on an existing house design, through to delivered files               |
| `roadmap-edits`       | 30    | 0         | Multi-turn edits on one design. Graded inside the factory in plumb-v1                       |
| `direct-execution`    | 2     | 0         | A fixed request sent straight to the factory with no model, to isolate the build and checks |

The planner cases cover nine kinds of request: supported edits, requests that must be refused,
requests that must be asked about first, scope, locked requirements, questions, room edits,
requests with a reference image, and whole houses set up from a manufacturer's public product page.
Each case states the exact answer expected of it: the outcome, the workflow, and the operations.
For the manufacturer cases, `source` says which figures the page states and which the case adds.

**Dev and held out.** About one case in five is held out: the first hex digit of
`sha256("factory-corpus@0:" + flow + "/" + id)` is 0, 1 or 2. Dev cases are published here with
their contents. Held-out cases are never published, only counted, so a reported number can be
checked against cases nobody outside has seen. Each held-out case has a SHA-256 commitment in
`heldout.json`, so a case released later can be matched to the numbers computed on it.

"Held out" in plumb-v1 means _not published_. It does not mean _unseen_: the cases were written by
the same people who work on the factory, before and alongside it. A held-out set written after the
factory's prompt is frozen, by people who do not tune it, is planned for a later corpus.

## What is measured

| Measure              | What counts                                                                                                                                                                                                  | What it does not show                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verified design**  | Of the cases whose answer is a design: the factory ran, an independent check accepted the result, every delivery was ready, and the typed proposal is the one the case expects. The headline number          | That the design is engineered, buildable or fit to fabricate. Checks may say "not assessed" or "input required", and a ready delivery can carry them |
| **Typed proposal**   | The answer's workflow, outcome, candidate count and every operation match the case, with no extra operations, and protected values are left alone                                                            | Anything about the build or the files                                                                                                                |
| **Honesty**          | Stops required (the case must be refused or asked about). False claims: a stop was required and the answer delivered a design instead. Over-refusals: work was possible and the answer refused it            | Whether the open questions the answer lists are the right ones                                                                                       |
| **Constraints**      | Lock violations: a protected dimension or opening changed. Unit errors: a number off by a power of ten from the expected one                                                                                 | Units inside the files, which the readers check                                                                                                      |
| **Files open**       | Delivered IFC and DXF files that ifcopenshell and ezdxf, readers that share no code with the factory, open and find a concept model in: one project in metres with products, a clean DXF audit with entities | That a customer's own software accepts them                                                                                                          |
| **Reruns identical** | The same request, run again from the start, produced identical output                                                                                                                                        | That a model gives the same answer twice. Where the model's answers are reused, its stage is fixed                                                   |
| **Reliability**      | Runs, failures by code, timeouts                                                                                                                                                                             | Cancelling a job, which is not exercised                                                                                                             |
| **Cost and time**    | Run time p50 and p95, end to end with the model's time, model calls, tokens, cost in USD and EUR, and EUR per verified design                                                                                | Production latency, unless the result says the runner was not emulated                                                                               |

Every number is given for all cases, the dev split and the held-out split. A case nobody could
ask is unmeasured, never passed or failed, and counts in no rate. No model judges anything:
every measure has a typed answer to compare against.

## Grading

`graders/grade.mjs` decides the typed proposal, honesty and constraints from a model's answer and
the case. It needs Node 20 or later and `zod`. It parses the answer against
`schema/plan.schema.json` and the cross-field rules a JSON Schema cannot state (`planRules`), then
compares it with the expected answer. It judges protected values on the operations the answer
names. A protected value changed indirectly, by an operation that never names it, is caught only
inside the factory, so the grader can be more lenient there than the published factory numbers.
Nordform checks on every change that this grader and the factory's own agree on every recorded
answer.

The verified-design, reruns-identical and reliability numbers come from the factory's own report
of each run. `adapters/factory.mjs` states exactly what a factory must return for them, and opens
the returned files itself.

## Running it

```sh
npm install
# The model-alone arm (needs an Anthropic API key; about 40 calls):
ANTHROPIC_API_KEY=… node runners/model-alone.mjs --model claude-opus-5-5
node graders/grade.mjs --answers answers-model-alone-claude-opus-5-5.jsonl
# Any factory that answers the adapter's contract:
PLUMB_FACTORY_COMMAND="./my-factory --one-case" node adapters/factory.mjs
```

`readers/open_files.py` needs Python 3.9 or later with `ifcopenshell` and `ezdxf`.

No public endpoint runs Nordform's factory for the adapter yet. Nordform runs the same steps in its
own repository and publishes the results here.

## Results

`results/history.json` lists every dated run in order. A result is never replaced or removed, and
every run that covers the held-out split is published, whatever it shows. Nordform reruns Trueline
when the factory's kernels, checks, prompt, context or model change.

**2026-10-20, v0 shakedown.** The first run, on corpus v0 (the same cases and split as plumb-v1,
before plumb-v1 was frozen). Factory arm only: **the model-alone arm was not run.** The factory's
model stage reused answers from `claude-opus-5-5` recorded on 2026-10-16 under an earlier version
of its prompt, so it could not ask again after an invalid answer, as the product does. The runner
was emulated, so the times are not production latency.

| planner-to-artifact                  | All      | Dev      | Held out |
| ------------------------------------ | -------- | -------- | -------- |
| Verified designs                     | 23 of 28 | 19 of 23 | 4 of 5   |
| Typed proposal                       | 53 of 60 | 39 of 44 | 14 of 16 |
| False claims, of stops required      | 0 of 22  | 0 of 17  | 0 of 5   |
| Over-refusals, of cases needing work | 0 of 38  | 0 of 27  | 0 of 11  |
| Files open                           | 54 of 54 | 46 of 46 | 8 of 8   |
| Reruns identical                     | 25 of 26 | 21 of 22 | 4 of 4   |

Two of 53 runs failed, one of them a rerun. The roadmap flow measured nothing: every case needs a
live model, and none was asked. Of the two direct-execution requests, one was not identical on
rerun, because it carries no evaluation time and each run stamped its own. The held-out figures
rest on five cases and are not a rate. The full figures are in
`results/2026-10-20-v0-shakedown.json`.

## Licences

The code (`graders/`, `runners/`, `adapters/`, `readers/`, `schema/`, `prompts/`) is licensed under
the Apache License 2.0 (`LICENSE`). The data (`data/` and `results/`) is licensed under Creative
Commons Attribution 4.0 International (`data/LICENSE`). Attribute it as "Nordform Trueline, Nordform
Group Oy". The manufacturer cases cite a public product page and restate the figures it publishes;
the page itself is not reproduced.

## Citing

```
Nordform Trueline: an open benchmark for design factories. Nordform Group Oy, 2026.
Corpus plumb-v1.
```
