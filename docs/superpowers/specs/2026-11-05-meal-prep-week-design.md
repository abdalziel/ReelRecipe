# Meal Prep Week: design

Date: 2026-11-05
Status: all three open questions answered 2026-11-05, awaiting Blair's approval of the full document
Repo: ReelRecipe (web app in `backend/`, served at reelrecipe.ai on Railway)

## Intent

Blair meal-preps on Sunday. He wants ReelRecipe to choose the week's meals against the nutrition targets his fitness app (Forge) has set for his current training phase, turn that week into a Sunday cooking sheet and a single grocery list, and do it from a library that includes the 170 recipes he has collected from Instagram.

Three pieces of work, in this order:

1. Import the 170-recipe markdown file into the recipe library.
2. Make the planner safe and current: scope meal plans, diet plans and shopping lists to the signed-in user, and move the Claude calls to the current model generation.
3. Build the Prep Week feature on top of the existing planner, diet plan and shopping list.

ReelRecipe was chosen over Forge because it already has recipes with ingredients and per-serving macros, a weekly meal plan, a diet plan with daily macro targets, an AI step that fills a week from those, and shopping-list generation. Forge has none of the recipe or shopping layer. Forge stays the meal logger and the source of truth for nutrition targets.

## Goals

- Every one of the 170 recipes lands in Blair's library with ingredients, steps, servings, macros and the Instagram source, with the ones the source file flagged as low-confidence visibly marked for review.
- One tap proposes a full week that hits the active diet targets and matches Blair's prep structure. Blair can swap any meal before accepting.
- A Sunday prep sheet lists each batch with scaled ingredient quantities, the method, the container count and per-portion macros.
- One grocery list covers the whole week, split into what is needed for Sunday prep and what is needed for cooking fresh during the week.
- The planner, diet plan and shopping list only ever show the caller's own data.

## Non-goals

- A live link between Forge and ReelRecipe. Targets are copied into the Diet tab by hand when Forge changes phase. The live link is a follow-up.
- Changes to the ReelRecipe mobile folder. It is an untouched initial commit and stays out of scope.
- The guest landing page. That is a separate task with its own memory entry.
- Logging what was actually eaten. Forge does that.
- Leftover or pantry tracking.

## Anti-goals

What would make this a failure even if it technically works:

- A week with twenty-one different recipes. The planner must build batches and repeat them. Blair bought larger pans for exactly this.
- A grocery list that mixes Sunday-prep ingredients with during-the-week ingredients, so he cannot tell what must still be fresh on Thursday.
- Losing the imported recipes on the next deploy. See the database constraint below.
- Macros that were estimated by the model shown as if the original post stated them.
- Any planner, diet or shopping endpoint that reads another account's rows.

## Blair's weekly shape (his numbers)

| Meal | Per week | Prepped on Sunday | Cooked fresh |
|---|---|---|---|
| Breakfast | 7 | 3 premade backups | 4 (ingredients stocked) |
| Lunch | 7 | 7 | 0 |
| Dinner | 7 | 4 | 3 |
| Snack | about 7 | all | 0 |

Snacks: about one a day, sometimes more than one serving, and some days none. Snacks are a Sunday batch (one snack recipe, portion count set by the planner to land the calories, a day may go without). Claude's call on prepped versus fresh; Blair said "about 1 snack per day, might be multiple servings, some days might not snack".

Repeating the same meal several times in a week is fine and preferred. Backup breakfasts are for mornings he is running late; the other four are cooked fresh from stocked ingredients.

Sunday is the cook day. The grocery trip is Friday or Sunday, one trip, covering both the Sunday cook and the week's fresh cooking.

## Constraints

- Approve before publish: Blair sees the work on a preview before anything reaches reelrecipe.ai (memory: `feedback_approve_before_publish`).
- Model tier: `claude-sonnet-5` for extraction, diet analysis and the week chooser; `claude-haiku-5-5` for ingredient categorization and shopping-list consolidation (memory: `feedback_claude_model_tier`). The codebase currently calls `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`.
- UI copy: complete sentences, no copy that restates a label, no em or en dashes mid-sentence, no controls Blair did not ask for (memories: `feedback_full_sentences_ui_copy`, `feedback_no_obvious_ui_copy`, `feedback_no_em_dashes`, `feedback_no_unrequested_controls`).
- Every wait the user sits through gets a determinate progress bar with a time estimate. The 170-recipe import is roughly 170 model calls and will take minutes.
- Build passes locally before any commit.
- Production database: Postgres on Railway (verified 2026-11-05, see open question 3). Local development uses the SQLite file in `backend/`, which is stale (no `users` table). Schema changes must work on both.
- Existing code to build on, not replace: `services/recipe_extractor.py` (`_JSON_STRUCTURE`, `_RULES`, `_parse_response`, `categorize_ingredient`), `services/duplicate_detector.find_duplicate`, `services/diet_analyzer.suggest_meal_plan`, `services/shopping_list.create_shopping_list_from_recipes`, `services/auth.Scope` and `get_scope`, the Planner, Diet and Shopping tabs in `static/app.js`.

## Piece 1: markdown import

### The source file

`imports/Fooooood-Recipes-Complete-170.md` in this repo (the `imports/` folder is gitignored; the file is Blair's personal collection and stays out of version control). About 244 KB, 4,572 lines. Layout:

- A title block, an index of 170 numbered titles, then four `## Batch` sections.
- Each recipe is a `### N. Title` heading followed by bold-labelled prose paragraphs.
- Every recipe has a `**Source:**` line: an Instagram handle and, for most, a reel URL.
- Ingredients and method are prose, not tables. Labels vary (Ingredients, Sauce, Rice, Burritos, Method, Makes, Servings / macros / time, Servings / macros, Time, Freezing / reheating, Storage).
- Macros sit inside sentences, for example "Per serving: 480 calories, 51g protein, 44g carbs, 10g fat."
- 112 of the 170 carry a `**Low-confidence note:**` or similar. Some have unstated amounts or servings.

### Decided

- Split the file on `### N. Title` headings. Parse the Source line with a regex (handle and URL are reliable). Send everything else in the chunk to the model.
- Add `extract_recipe_from_text(title, body)` to `recipe_extractor.py` that reuses the existing JSON structure and rules so the result matches what the reel and web importers produce. One call per recipe, `claude-sonnet-5`.
- Macros: where the post states them, keep them verbatim. Where it does not, the model estimates them and the recipe is marked "macros estimated". Every recipe needs macros for the planner to work; an unmarked estimate is an anti-goal.
- Low-confidence notes from the file are stored on the recipe and shown in the library and on the recipe page as a review flag. A recipe keeps the flag until Blair clears it.
- `source_type` is `instagram_reel`, `source_url` is the reel URL when present, and the handle is kept (a new column or the description, builder's choice, but it must be queryable later).
- Duplicate detection runs against the caller's existing library using `find_duplicate`. A duplicate is skipped and reported, not merged.
- The import is idempotent: running the same file twice adds nothing. Match on source URL first, title second.
- The import runs as a background job with a progress endpoint. The Import tab gets a "Import recipes from a markdown file" entry with a file picker, then a determinate progress bar (recipes done of total, time remaining from the measured per-recipe pace) and a final summary: imported, skipped as duplicate, failed, flagged for review.
- Failures on individual recipes do not stop the job. They are listed at the end with the recipe title and the reason, and can be retried.
- The importer is general: any markdown file whose recipes are under `###` headings works. It is not special-cased to this one file beyond the Source-line regex.
- Public library: the reel and web importers call `_auto_publish()` in `routers/reels.py`, which commits each recipe to the public GitHub repo before the duplicate check. The markdown importer does NOT do this (see open question 1 for Blair's ruling). Recipes can be published later one at a time through whatever path the app already offers.
- Job pattern: reuse the one in `routers/instagram.py` and `services/instagram_scraper.py` (module-level current job, `BackgroundTasks`, a status endpoint, and `startBulkPoll()` in `static/app.js` polling every two seconds). The existing bulk-import card in the Import tab is blurred as work in progress; the markdown importer gets its own card.
- SDK: `anthropic==0.40.0` predates structured outputs. The builder upgrades the SDK (and `httpx`, pinned alongside it) as part of Piece 1 and confirms the existing extractors still pass. Claude's call.

### Left to the builder

- Job runner (FastAPI background task with an in-memory or DB-backed job row is fine for one user; no queue needed).
- Concurrency of model calls (a small bounded pool is fine; respect rate limits).
- Whether the review flag is a column or a tag. It must be filterable in the library.

## Piece 2: scoping and model refresh

### Decided

- The Planner, Diet and Shopping tabs require sign-in. `meal_plan.py`, `diet.py` and `shopping_list.py` use `require_user` and filter every query by `user_id`. There is no anonymous access to these three tabs, because the anonymous rule on recipes (`client_id IS NULL` rows are visible to any anonymous caller) would expose legacy rows, and Prep Week stores the weekly shape on the user. `MealPlan`, `DietPlan` and `ShoppingList` get a `user_id` column only. Claude's call.
- Existing rows with no owner are legacy and are assigned in a one-off migration to the user whose email matches `ADMIN_EMAIL` in `config.py` (Blair's account; he is the only real user of these tabs today).
- The AI-align step reads only the caller's recipes. Today it calls `db.query(Recipe).all()`.
- All model identifiers move to `claude-sonnet-5` and `claude-haiku-5-5` as set out in the constraints. Prompts are not rewritten in this piece beyond what the model change needs.
- The shopping-list "split into two runs by halves" logic is removed; Piece 3 replaces it with a split by purpose.

### Left to the builder

- Migration mechanism. The app appears to rely on `create_all`; the builder decides whether to add a lightweight migration step or extend `create_all` with column checks, and documents it.

## Piece 3: Prep Week

### Concepts

- **Weekly shape**: the table above, stored as JSON on the user and copied onto each meal plan when it is created, so a past week keeps the shape it was planned with. The Diet tab shows the shape as plain text with an edit affordance. There are no other controls.
- **Prep mode** on each `MealPlanEntry`: `prep` (cooked Sunday, portioned), `fresh` (cooked that day), or `backup` (premade breakfast kept for late mornings). Backup breakfasts sit on the days they are most likely needed, but the planner treats them as a Sunday batch of three.
- **Batch**: a derived grouping, not a table. All `prep` or `backup` entries sharing a recipe form one batch whose portion count is the sum of their servings. Batches are what the prep sheet and the grocery list are built from.
- **Diet plan** (existing) carries the phase targets copied from Forge: daily calories, protein, carbs, fat. It gains optional training-day and rest-day calories and an optional set of training weekdays. If those are blank, every day uses the single daily target.
- **Entering the targets**: the Diet tab today only creates plans by having the model analyze free text or a PDF, which is too loose for the one input the feature depends on. The Diet tab gets a small numeric form: phase name, daily calories, protein, carbs, fat, and the optional training-day and rest-day calories with a weekday picker. Saving it creates or updates the active diet plan directly, no model call. The text and PDF paths stay for everyone else. This is a control Blair did not ask for, added because the feature cannot work without an exact entry path. Claude's call.

### The week chooser

An upgraded `suggest_meal_plan`, called from the Planner tab by the existing align action.

Inputs: the active diet plan, the weekly shape, and the caller's recipe library (id, title, meal type, servings, prep and cook time, macros, tags, review flag).

Rules the prompt enforces:

- Build the week from batches. Target two lunch batches, two prepped-dinner batches and one backup-breakfast batch, with repeats across days. The builder may let the model pick one or three batches when the macros work better, but never seven distinct lunches.
- Fresh dinners (3) and fresh breakfasts (4) come from recipes with total time of 30 minutes or less. Fresh breakfasts may repeat.
- Snacks: one snack recipe as a Sunday batch, about seven servings across the week. The planner uses snack servings as the slack that lands each day on its calorie target: a day may get two servings or none. Snack recipes are those with meal type snack, smoothie, shake or dessert.
- Daily totals land within 5 percent of the calorie target and at or above the protein target. Carbs and fat are secondary.
- When training-day and rest-day calories differ, the difference is made on the carb side of a prepped meal (a larger or smaller rice or tortilla portion, written as a per-day note on the entry), not by choosing different recipes for different days. This is Claude's call from the brainstorm; Blair has not objected.
- Recipes flagged for review are allowed but the model prefers unflagged ones when macros are close.
- Output is structured: one entry per day and slot with recipe id, servings, prep mode and an optional portion note. The builder uses the SDK's structured-output support rather than parsing free text.

The Planner shows the proposed week in the existing day grid, with each entry marked prep, fresh or backup. Blair swaps entries with the existing recipe picker. Accepting the week is what unlocks the prep sheet and grocery list; until then the align action can be rerun.

Which week: today the Planner loads the newest plan and never makes another, and `getMonday()` returns the current week's Monday, so on a Sunday it would plan the week that is ending. Instead: when the Planner opens and the newest plan is accepted or its week has ended, the app creates the plan for the coming Monday and shows that. On a Sunday, that is tomorrow's week. There is no "new week" button; the rollover is automatic. Past weeks stay reachable through the existing plan list. Claude's call.

### Prep sheet

A view reached from the Planner once a week is accepted, with a print stylesheet so it works as a single printed sheet.

Sections, in order:

1. **Sunday batches**, longest total time first so the long cooks start first. Each batch shows: recipe title, portion count, scaled ingredient list (recipe quantity times portions divided by recipe servings, rounded sensibly), method steps, per-portion macros, and the source handle.
2. **Backup breakfasts**, same layout, as a batch of three.
3. **Fresh this week**: the three dinners and four breakfasts, each with its day, its unscaled ingredients for the number of servings planned, and the method. These are there for reference while cooking during the week.

Daily macro totals appear once per day, in a small table at the top, not repeated per batch.

### Grocery list

One list, generated from the accepted week by the existing `generate-from-plan` path. Two sections:

- **For Sunday prep**: ingredients from every `prep` and `backup` entry, consolidated across batches and grouped by store category.
- **For the week**: ingredients from every `fresh` entry, consolidated and grouped the same way.

An ingredient that appears in both sections appears in both with its own quantity. Nothing is merged across sections, because the two sections answer different questions (what to cook Sunday versus what must still be fresh later in the week).

The existing shopping tab behaviour (check items off, keep lists) is unchanged.

### Left to the builder

- Prompt wording and the structured-output schema for the chooser.
- Rounding rules for scaled quantities (for example, 2.33 eggs rounds up; 0.33 tsp stays fractional).
- Print CSS.
- How the prep, fresh and backup marks look in the day grid.
- Where the "accept this week" state lives (a column on `MealPlan` is fine).

## Follow-ups, not in this build

- Forge link: ReelRecipe reads the latest Forge backup snapshot from Supabase Storage, or Forge pushes targets on a phase change. Needs both apps to share a login.
- Forge "repeat" meals seeded from the ReelRecipe prep week, so logging a prepped bowl is one tap.
- Landing page for guests (separate memory entry).

## Open questions for Blair

Raised by the builder check on 2026-11-05. Answers get written back into the sections above.

1. **Public library.** Should any of the 170 imported recipes be auto-published to the public ReelRecipe library the way reel imports are? The design currently says no: they stay private, and 112 of them are low-confidence. Claude's recommendation is to keep it that way and publish selectively later.
2. **Snacks.** ANSWERED 2026-11-05: yes, about one a day, sometimes multiple servings, some days none. Written into the weekly shape and the chooser rules above.
3. **Production database.** ANSWERED 2026-11-05 by checking Railway: the ReelRecipe service (Railway project `adaptable-wonder`, service `ReelRecipe`) has `DATABASE_URL` set to the Postgres service in project `lucky-renewal`. Data persists across deploys. The import may run against production once Pieces 1 and 2 are approved on a preview. Side note for the builder: no R2 variables are set in production and the service has no volume, so thumbnails written to `uploads/` on the server do not survive a redeploy. Out of scope here, but do not rely on local uploads for anything new.
