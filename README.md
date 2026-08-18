# TTB Label Check

A prototype that compares an alcohol beverage label image against its COLA application
record and tells a compliance agent, in plain language, what matches and what does not.

---

## The one design decision that matters

**The model reads the label. Code decides compliance.**

Every determination in this tool is made by pure, deterministic TypeScript in
[`server/rules/`](server/rules/). Claude is used for exactly one thing: transcribing what is
physically printed on the label into structured JSON. It is never asked whether a label is
compliant, whether a warning is correct, or whether anything matches the application.

That boundary is not stylistic. It falls out of what the stakeholders described:

> "It has to be exact. Like, word-for-word, and the 'GOVERNMENT WARNING:' part has to be in
> all caps and bold. […] I caught one last month where they used 'Government Warning' in
> title case instead of all caps. Rejected." — Jenny Park

A language model asked *"is this warning correct?"* will frequently say yes to
`Government Warning:` in title case, because it reads for **meaning** and the meaning is
identical. TTB needs it read for **characters**. String equality against 27 CFR 16.21 is not
a task that benefits from intelligence — it is a task that benefits from being incapable of
being clever.

The split buys three things a federal agency actually needs:

| | Why it matters here |
|---|---|
| **Auditability** | A rejection cites a CFR section and a character-level diff, not "the AI flagged it". |
| **Reproducibility** | Determinations are re-derivable from the stored transcription years later, without re-running a model that has since changed. |
| **Testability** | 85 tests cover the entire compliance surface with no API key and no network. |

```
    label image
         │
         ▼
  ┌──────────────┐   EXIF rotate, downscale to 2576px, re-encode
  │ prepare      │
  └──────┬───────┘
         ▼
  ┌──────────────┐   Claude Opus 5 + structured outputs
  │ transcribe   │   "report what is printed" — no judgement
  └──────┬───────┘
         ▼
    LabelExtraction  ◄── the evidence, stored and shown to the agent
         │
         ▼
  ┌──────────────┐   pure TypeScript, no I/O, no clock, no randomness
  │ rules engine │   ← every compliance decision lives here
  └──────┬───────┘
         ▼
   pass / review / fail  + citation + diff per check
```

---

## Quick start

```bash
npm install && cp .env.example .env && npm run samples && npm run dev
```

Then open **http://localhost:5173**.

`.env.example` ships with `DEMO_MODE=true`, so **it runs with no API key** — see below. To check
real labels, paste your key into `.env` and set `DEMO_MODE=false`.

| Command | What it does | Needs a key |
|---|---|---|
| `npm test` | 56 unit tests over the whole rules engine | no |
| `npm run samples` | Generates the 8 demo labels + manifest CSV | no |
| `npm run smoke` | End-to-end HTTP test against a running server | no |
| `npm run dev` | API + UI with hot reload | no (demo mode) |
| `npm run inspect -- <image>` | Dump one label's raw transcription and every check | **yes** |
| `npm run bench` | Latency measurement | **yes** |

`npm run inspect` exists for one question: when a check fails, was the label wrong or did the
model mis-read it? It prints the verbatim transcription and the first differing character of
the government warning.

### Running without an API key

`DEMO_MODE=true` serves stored transcriptions of the sample labels instead of calling the API.
The entire pipeline downstream of the model — rules engine, verdict rollup, diff rendering,
batch streaming, CSV export — runs exactly as it does live.

This exists so that whoever reviews this project can clone it and see it work immediately
rather than hitting a "no API key" wall, and so the rules engine can be iterated on without
spending tokens on every change.

Two deliberate constraints:

- **It is opt-in only.** Demo mode is never a silent fallback. If a live API call fails, the
  tool reports the failure — it never quietly substitutes fixture data for a real result.
- **It is visibly labelled.** A red banner sits at the top of every screen, results carry a
  "Demo data" badge, and the model field reads `demo (stored transcription)`. A demo result
  can't be mistaken for a determination.

[`test/fixtures.test.ts`](test/fixtures.test.ts) asserts that each fixture actually produces
the failure its sample advertises — a demo that silently drifts into showing the wrong thing
is worse than no demo, because it teaches a reviewer the wrong lesson about what the tool does.

### Running it as one process

```bash
npm run build && npm start        # http://localhost:3001
```

In production the compiled frontend is served by the same Express process that answers
`/api/…`. One process, one port, no proxy, and no CORS surface — there is nothing to configure
at deploy time beyond the API key.

### Deploying

A `Dockerfile` is included and the image needs exactly one runtime secret:

```bash
docker build -t ttb-label-check .
docker run -p 3001:3001 -e ANTHROPIC_API_KEY=sk-ant-... ttb-label-check
```

`.env` is excluded from the image by `.dockerignore`, so a key can only ever arrive from the
platform's secret store. Any host that runs a container works — Render, Railway, Fly.io, or
Azure Container Apps, which is where Marcus said the agency already is.

**One thing to settle before a real pilot:** Marcus flagged that the agency firewall blocked
the previous vendor's ML endpoints. This tool needs outbound access to `api.anthropic.com`,
and that is a procurement conversation to have *before* a pilot rather than during one. Until
it is allowlisted, `DEMO_MODE=true` runs the entire interface against stored transcriptions
with no outbound calls at all.

---

## What it checks

| Check | Rule | How it is decided |
|---|---|---|
| Brand name | 27 CFR 5.63 / 4.32 / 7.62 | Normalized comparison with a graded match (see below) |
| Class / type | 27 CFR 5.63 / 4.32 / 7.62 | Same |
| Alcohol content | 27 CFR 5.65 / 4.36 / 7.71 | Numeric tolerance by beverage class, plus proof = 2 × ABV |
| Net contents | 27 CFR 5.203 / 4.72 | Match to application **and** membership of the authorized standards of fill |
| Bottler name/address | 27 CFR 5.66 / 4.35 / 7.66 | Normalized comparison, more lenient than brand |
| Country of origin | 19 CFR 134 | Only when the application marks the product as imported |
| Government warning | 27 CFR 16.21 | **Character-for-character equality** plus caps/bold/separation |
| Warning type size | 27 CFR 16.22 | Always deferred to a human — see *Honest limitations* |
| Image quality | internal | Gates everything else; an unreadable photo produces no findings at all |

### The `STONE'S THROW` problem

> "I had one last week where the brand name was 'STONE'S THROW' on the label but
> 'Stone's Throw' in the application. Technically a mismatch? Sure. But it's obviously the
> same thing. You need judgment." — Dave Morrison

Name comparison grades into four tiers rather than returning a boolean, because the tiers map
onto agent workload:

| Tier | Meaning | Agent time |
|---|---|---|
| `exact` | Identical as printed | none |
| `equivalent` | Differs only in case, punctuation, word order, or abbreviation | none, but the difference is stated |
| `close` | Probably the same, possibly a typo | eyeball it |
| `different` | Not the same thing | act |

There is a test asserting `STONE'S THROW` vs `Stone's Throw` **passes**. Flagging it is the
failure mode, not the success mode — a tool that cries wolf on capitalization gets switched
off in a week, which is the outcome Dave has watched happen before.

---

## Assumptions made

Gaps in the brief, and how each was resolved. These are judgement calls, not facts — each one
is a place where a stakeholder could reasonably say "no, do it the other way".

| Assumption | Why | If wrong |
|---|---|---|
| The application record is the source of truth; the label is the thing under test | Mirrors what an agent does — the COLA submission is what the applicant asserted, and review asks whether the artwork honours it | Nothing structural changes; the comparison direction is symmetric |
| Case, punctuation, word order, corporate suffixes and state abbreviations are cosmetic in names | Dave's `STONE'S THROW` case. Flagging these makes the tool useless within a week | Tighten `normalizeForMatch`; the tiers already separate "equivalent" from "close" |
| Wording of the government warning is case-insensitive; only the `GOVERNMENT WARNING` prefix must be capitals | 16.21 fixes the words, 16.22 fixes the prefix's case and weight. Many real labels set the whole statement in capitals | One line in `checkGovernmentWarning`; the caps check is already separate |
| Type size and bold are deferred to a human, never auto-failed | Millimetres cannot be measured from a photo without a scale reference, and stroke weight is unreadable on curved glass | Remove `requiresAgentConfirmation`; the finding is already produced |
| ABV tolerance applies to label-vs-application agreement | The prototype compares two declarations. The regulation's tolerance may instead govern label-vs-laboratory-analysis — a different question | Constants are isolated in `reference.ts` with a `NEEDS SME SIGN-OFF` marker |
| A beverage class must be supplied per application | Standards of fill, mandatory elements and ABV tolerance all vary by class, and none can be safely inferred from artwork alone | Would need a class-detection step and a confidence gate on it |
| No authentication, because the brief scoped this as a standalone proof of concept | Marcus: "for a prototype? Just don't do anything crazy" | See the production checklist below — auth is item one |
| Images are transient and nothing is persisted | Marcus: "We're not storing anything sensitive for this exercise" | Adding persistence means a retention policy first, not a database first |

---

## Honest limitations

These are deliberate. Naming them is more useful than hiding them.

**0. One image is treated as one complete label. Real submissions are multi-panel.**

This is the biggest gap, and it was found by running a real bottle through the tool rather
than a generated sample. A wine bottle carries its brand and class/type on the front and its
net contents, name and address, and government warning on the back. Upload both and each is
evaluated as if it were the whole label, so the front is reported as missing a government
warning and missing net contents — both of which are present, on the other panel.

The fix is not large but it is structural: let the manifest map several images to one
`applicationId`, merge the transcriptions across those panels, then run the checks once
against the merged result. The rules engine needs no changes at all — it already takes a
single `LabelExtraction`. Only the batching layer and the manifest format do.

Until that exists, check one panel per application, or treat "missing" findings on a
single-panel upload as unverified rather than as violations. 27 CFR 16.22 specifies a minimum
character height *in millimetres*, which depends on the physical container. A photograph has
no scale reference. This check therefore **never returns a pass** — it reports the warning's
size relative to the largest text on the label and defers to the agent. Pretending to measure
millimetres from a JPEG would be the single most dangerous thing this tool could do.

Crucially, that check is excluded from the overall verdict rollup. If it were included, every
label would come back "needs review" and the tool would save nobody any time — which is
precisely how the previous scanning-vendor pilot failed. There is a regression test for this.

**2. ABV tolerances need a compliance SME sign-off.** The values in
[`server/rules/reference.ts`](server/rules/reference.ts) are marked `NEEDS SME SIGN-OFF`.
There is also a substantive question the prototype deliberately does not answer: whether TTB
applies these tolerances to *label vs. application* agreement (modelled here) or only to
*label vs. laboratory analysis*. Those are different questions.

**3. Standards of fill move.** TTB substantially expanded the authorized container sizes
effective 2025. A tool built on the older short list would reject a lawful 700 mL bottle.
Every such constant lives in one cited file so that a regulatory change is a one-line diff,
not an archaeology expedition.

**4. This is a single-label tool, not a COLA integration.** Per Marcus Williams, integration
was explicitly out of scope. Nothing is stored, filed, or transmitted anywhere.

**5. It does not decide anything.** Every output is a suggestion for an agent to confirm or
overrule. The UI says so on every screen.

---

## Performance

> "The system would take 30, 40 seconds sometimes to process a single label. Our agents just
> went back to doing it by eye […] If we can't get results back in about 5 seconds, nobody's
> going to use it." — Sarah Chen

Latency is a functional requirement here, so it was measured rather than asserted.

### Measured results

8 sample labels, repeated runs, single-label sequential path (what one agent waits for):

| Model | Image cap | p50 | p95 | Inside 5s |
|---|---|---|---|---|
| Sonnet 5 (thinking on) | 2576px | 7.54s | 8.74s | **0%** |
| Sonnet 5 (thinking off) | 2576px | 7.03s | 12.34s | **0%** |
| Sonnet 5 (thinking off) | 1100px | 6.82s | 8.14s | **0%** |
| Haiku 4.5 | 2576px | 4.97s | 11.52s | 56% |
| Haiku 4.5 | 1100px | 4.55s | 5.49s | **79%** |

Batch, at concurrency 6: Sonnet 5 ≈1.9s per label wall-clock (~9.7 min for 300 labels);
Haiku 4.5 ≈1.25s (~6.3 min).

Reproduce with `npm run bench -- --model <id> --image-edge <px> --thinking <adaptive|disabled>`.
Latency depends on your key and network, so re-measure before relying on these.

### The honest finding: latency and accuracy are in tension here

**Sonnet 5 does not meet the five-second budget.** Not at any setting tested. Turning thinking
off saved ~0.5s and shrinking the image saved ~0.2s, because neither is the bottleneck —
generating ~440 output tokens is, and most of those tokens are the verbatim government warning
that the exact-match check depends on.

**Haiku 4.5 meets the budget but fails the safety gate.** It got 7 of 8 sample verdicts right.
The one it missed is the one that matters most: on the deliberately degraded photo — rotated
7°, darkened, glared, JPEG-compressed — it reported `imageLegible: true`, an *empty* list of
quality issues, and 0.95–0.98 confidence, across three consecutive runs. Its overall verdict
on that label also swung between `fail` and `review` between runs.

That is disqualifying, and not because of the single wrong verdict. The image-quality gate —
the thing that stops this tool producing confident findings from an unreadable photo — rests
entirely on the model's own assessment of whether it could read the label. Haiku's assessment
is not calibrated, so with Haiku the gate silently stops working, which is precisely the
"confident answer from a bad image" failure the gate exists to prevent.

Sonnet 5 flagged the same image `review` on 3 of 3 runs, naming "photographed at an angle" and
"slight glare in center of label" at 0.9 confidence.

**This is a decision for the Compliance Division, not one to paper over in code.** The options,
with the evidence attached:

1. **Accept ~7s for single-label review.** The 5-second figure came from a vendor that took
   30–40s. 7s with a correct answer and a visible progress indicator is a different
   proposition — but that is Sarah's call to make, not this prototype's.
2. **Use batch mode as the primary workflow.** It already beats the budget at ~1.9s per label,
   and it is what the 200–300-label importer submissions need anyway.
3. **Use Haiku only where a human is definitely looking at the image anyway**, never as the
   sole gate on image quality.
4. **Reduce the output.** The warning transcription dominates generation. Reading it in a
   second parallel call, or streaming the response so fields appear progressively, would cut
   perceived latency. Neither is built here.

### Second reading on a disputed warning

Transcription is very stable but not perfect: across repeat runs the warning came back
character-identical 9 times out of 9, and one earlier run mis-read a word on a label whose
warning was actually correct.

A false positive on the warning is the most expensive error this tool can make — an agent sent
to look at three warnings that turn out to be fine stops looking carefully at the fourth. So a
wording mismatch is not trusted on a single reading. The label is read again, and if the two
readings disagree *with each other*, the check reports `review` rather than `fail`.

Deliberately not "prefer whichever reading passes": when two readings disagree, the honest
answer is that the tool is unsure, and an unsure answer belongs with a human. Genuine
violations reproduce, so they still fail — verified live against the title-case and reworded
samples. The extra call happens only on the mismatch path, so it costs nothing on the labels
that are fine.

Disable with `CONFIRM_DISPUTED_WARNING=false`.

Choices made to protect the budget, all of them measured:

- **`effort: low`** and **thinking off**. Reading text off an image is perception, not
  reasoning, and every actual decision is made in code. Neither turned out to be the
  bottleneck, but neither earns its cost either — the extracted fields were identical.
- **One API call per label** on the happy path. No multi-pass refinement, no self-critique.
- **No streaming.** The response is a small fixed-shape JSON object. Streaming would improve
  *perceived* latency and is the most promising unexplored lever, but it does not change
  time-to-complete-result, which is what an agent actually waits for before acting.

`ANTHROPIC_MODEL` swaps models. Read the tension section above before choosing one — the
fastest option is not the safest, and the difference is not a matter of taste.

### Batch

Batch results stream back as newline-delimited JSON and render **as each label finishes**, so
a 300-label run is useful within seconds rather than after the whole run completes. Concurrency
is bounded (default 6) because unbounded fan-out trips API rate limits immediately and holding
300 decoded images in memory is a good way to run a server out of heap.

Results export to CSV — with a UTF-8 BOM so Excel on Windows opens it correctly, and with one
column per check so the run can be filed or printed. Dave prints his email; a CSV he can print
is worth more than a dashboard he has to keep open.

---

## Interface design

> "We need something my mother could figure out — she's 73 […] Half our team is over 50.
> Clean, obvious, no hunting for buttons." — Sarah Chen

- 19px base text, 1.65 line height, nothing below 16px anywhere.
- One primary action per screen, in the same place and colour every time.
- Verdicts carried by **word + symbol + colour**, never colour alone — with 47 agents,
  assume at least one cannot rely on red vs green, and assume some of this gets printed.
- 48px minimum hit targets, well above the WCAG floor.
- Visible focus rings, never removed. Full keyboard operation.
- No hover-only affordances and no icon-only buttons.
- The application/label comparison is always visible, never behind a disclosure control —
  that side-by-side *is* the job.
- Findings sort with problems first and passes last.

---

## Tools used

Deliberately few. Every dependency here is either doing real work or is the boring standard
choice — a federal deployment reviews everything it ships, so a long dependency list is a cost
rather than a convenience.

| | | Why this one |
|---|---|---|
| **TypeScript** | language | The rules engine is the product. Types are what stop a `Verdict` string typo becoming a wrong determination. |
| **Node + Express** | API | Two routes and a streaming response. Anything heavier would be scaffolding around 300 lines of actual work. |
| **React + Vite** | UI | Batch results stream in one at a time and the table re-renders continuously; that is what a view library is for. |
| **sharp** | image prep | EXIF auto-rotation, downscaling, thumbnails. Phone photos arrive sideways and this is the one line that fixes it. |
| **multer** | uploads | Multipart parsing into memory, with size and count caps. |
| **@anthropic-ai/sdk** | vision | Structured outputs enforce the extraction schema at the API level, so no response parsing is done hopefully. |
| **node:test** | tests | In the standard library. 85 tests, zero test-framework dependencies. |

Written by hand rather than added as dependencies: the CSV parser (RFC 4180, ~40 lines — the
manifest format is fixed and tiny), Levenshtein distance and word-level diff, and the
bounded-concurrency pool. Each is short, exactly scoped, and independently tested.

---

## Layout

For a file-by-file walkthrough with real code excerpts, request/response contracts, and the
reasoning behind each boundary — see [`docs/TECHNICAL.md`](docs/TECHNICAL.md). This section is
the map; that document is the tour.

```
server/
  rules/            ← every compliance decision. Pure, tested, no I/O.
    reference.ts      CFR constants — the ONLY place regulatory data lives
    checks.ts         one function per mandatory element
    similarity.ts     graded name matching + word-level diff
    normalize.ts      text normalization, ABV/volume parsing
    index.ts          orchestration and verdict rollup
  claude/
    schema.ts         extraction JSON schema + transcription-only prompt
    extract.ts        the single API call, with refusal handling
    fixtures.ts       stored transcriptions for demo mode
  image/prepare.ts    EXIF rotation, downscale, thumbnail
  pool.ts             bounded-concurrency batch runner
  index.ts            Express API
web/src/              React UI
scripts/
  make-samples.ts     generates 8 demo labels, one per failure mode
  smoke.ts            end-to-end HTTP test against a running server
  bench.ts            latency measurement against the 5-second requirement
test/
  rules.test.ts       compliance logic, exhaustively
  pipeline.test.ts    image preparation and the concurrency pool
  fixtures.test.ts    each demo sample produces the failure it advertises
```

85 tests, none of which need an API key or a network.

---

## Sample labels

`npm run samples` generates one label per interesting failure mode, plus a matching
`applications.csv` for the batch tab:

| File | What it exercises |
|---|---|
| `01-compliant.png` | The happy path, from the project brief |
| `02-warning-title-case.png` | Jenny's catch — title case instead of all caps |
| `03-abv-mismatch.png` | Routine data-entry mismatch (40% vs 45%) |
| `04-warning-reworded.png` | One word changed deep inside the warning |
| `05-brand-case-variant.png` | Dave's case — **must pass** |
| `06-proof-mismatch.png` | Label contradicts itself: 45% ABV, 86 proof |
| `07-nonstandard-fill.png` | 800 mL, not an authorized standard of fill |
| `08-poor-image.jpg` | Correct label, badly photographed: rotated, dark, glared |

---

## If this went to production

Not built, because Marcus scoped this as a standalone proof-of-concept — but the shape of the
work:

- **Store the transcription, not just the verdict.** It is the evidence, and it makes
  determinations reproducible without re-running a model.
- **Human-in-the-loop feedback.** Capture every agent override. That is both the accuracy
  metric and the training signal for tuning thresholds.
- **Network egress.** Marcus flagged that the firewall blocked the last vendor's ML endpoints.
  `api.anthropic.com` needs allowlisting, and that is a procurement conversation to have
  before a pilot, not during one.
- **PII and retention.** Label artwork is generally public, but application records are not.
  Nothing is persisted here; a real deployment needs a retention policy first.
- **Rate limits and cost.** The benchmark reports per-label token usage; multiply by 150,000
  applications/year and take that number to procurement before promising a rollout.
- **Golden-set evaluation.** The real accuracy question is false-negative rate on genuine
  violations, which needs a labelled corpus of past determinations — not synthetic samples.

---

## Sources

Regulatory text verified against:

- [27 CFR 16.21 — Mandatory label information](https://www.law.cornell.edu/cfr/text/27/16.21) (health warning statement, verified verbatim)
- [27 CFR 5.203 — Standards of fill](https://www.law.cornell.edu/cfr/text/27/5.203) (distilled spirits container sizes)
- [TTB — Distilled Spirits Labeling](https://www.ttb.gov/regulated-commodities/beverage-alcohol/distilled-spirits/ds-labeling-home/ds-net-contents)
