# PingRoom guided troubleshooting starter

Follow a fixed troubleshooting runbook for a local support case. A named person answers one PingRoom Question at a time; code follows each selected branch and saves a recommendation with the observations that led there.

The sample asks about a printer display and an existing queue. A dark display ends the guide after one question; a lit display leads to a queue question. **Unknown / not applicable**, expired, cancelled, and invalid answers end the case as inconclusive. The starter runs no commands, changes no settings, fetches no supplied URLs, and performs no repairs.

This workflow follows symptom-dependent branches. It does not search an ordered set of builds or assume that a regression is monotonic.

## Try it offline

Choose **Use this template** on GitHub, then clone your new repository. Or clone this starter:

```sh
git clone https://github.com/pingroom/starter-guided-troubleshooting.git
cd starter-guided-troubleshooting
nvm use
npm ci
npm test
npm run demo
```

Node 22 or newer is required. Tests and demos need no credentials. They exercise the actual pinned SDK through a local mock transport with no network fallback. The demo covers a two-question path, a shorter path, and an inconclusive observation; temporary state is removed afterward.

Dependencies are exact versions with a lockfile. `@pingroom/sdk` is pinned to `0.6.0`, which meets this project's 14-day release-age policy. CI runs the install, tests and demo on Node 22 and 24.

## Connect a real room

Install [PingRoom](https://pingroom.io/i), create a standard private room, and add the person who will observe the case. Then:

```sh
npm run connect
npm run inspect
cp config.example.json config.json
cp examples/case.json case.json
```

Open the printed pairing URL, approve the connection and select the observer's room. The setup stores credentials privately in `.pingroom/credentials.json`. `inspect` lists member UUIDs with names as a lookup aid. Verify the intended person in the app and put their exact UUID and a label in `config.json`. Replace the fixture UUID before a live run. The connection needs access to that room, room reads, and Question creation/reads.

Alternatively, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete environment pair overrides saved credentials. Partial or blank overrides fail; credentials from different sources are never combined. Use the **same originating registration credential** for later reads and recovery: a new pairing cannot read the old registration's Questions.

Review `case.json` before starting. It contains the case ID, a brief summary, runbook version, entry node and all branches. Prompts and the case summary are sent to the selected PingRoom room. Use only information appropriate for that room.

```sh
npm run plan     # Validate and display the complete local runbook; no API calls.
npm start        # Create one question, or read the current one.
npm run status  # Read only local saved state.
```

Answer on the phone, then run `npm start` again to record it. A `ready` result means another observation is needed; a subsequent run creates that question. Each invocation performs at most one Question creation or read. No scheduler is installed and nothing automatically retries a failed POST. A Question lasts 15 minutes.

```sh
npm run report  # Save .case/report.json locally.
```

The report records the traversed node IDs, selected labels and values, Question IDs, responder and asker UUIDs, and observation timestamps. `complete` means a configured recommendation leaf was reached. It is not a verified diagnosis, a delivery/read receipt, or authority to execute a repair. `inconclusive` always has a null recommendation.

For `npm start`, `find-id` and `recover`, exit codes are 0 for a completed recommendation, 1 for an error, 2 for an inconclusive case, 3 for pending/ready/interrupted work, and 4 for uncertain creation. Local `plan`, `status` and `report` return 0 when their command succeeds; inspect their JSON status separately.

## Resume an uncertain creation

The exact request, attempt ID and idempotency key are saved before a Question POST. A lost response or failed save leaves `create_unknown`; running again does **not** create a replacement.

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` shows matching `candidates` from the API's bounded recent list (at most 200). An empty list does not prove the original request failed. Recovery reads one exact ID and validates its room, request, target, options, correlation/data, originating agent, lifetime and answer. It never resends a Question. If the original ID cannot be established, preserve the state and resolve the case manually; do not erase it merely to unblock creation.

Network errors and malformed or mismatched Question envelopes preserve the last saved state and produce no recommendation. A valid Question envelope containing an unsupported answer is recorded as `invalid_answer` and ends inconclusively. A terminal result is not re-polled or changed by later runs.

If pairing creation itself becomes uncertain, `connect` also preserves its intent and refuses another registration. Inspect Connected Agents, resolve or revoke any created robot, and archive that pairing intent only after deliberately choosing a new setup. Keep the original credential for cases already started.

## Adapt the runbook

- Use a unique case ID and version. Each observation has 1–3 distinct `{value, label, next}` branches; code adds **Unknown / not applicable** automatically. Every `next` names a node ID.
- Use `kind: "recommendation"` with plain `text` for leaves. The engine treats all text as data. Add any external action only in a separate reviewed integration; none is included here.
- Keep 2–24 nodes, with an observation entry. All nodes must be reachable, every branch must resolve, and cycles are rejected before API access. Multiple branches may share a downstream node.
- Bounds are 60 characters for the title, 120 for the case summary, 200 per observation prompt, 40 per option label and 400 per recommendation. Text is printable ASCII. IDs use lowercase letters, digits, underscores and hyphens, starting with a letter.
- Keep observations concrete and include only branches the runbook author supports. Unknown is a terminal result; code never invents a branch or guesses a cause. Human observations may be mistaken or stale.

`src/model.js` validates the graph and reconstructs the path; `src/engine.js` manages one durable step; `src/question.js` checks remote evidence. Control flow and exact rules stay in application code. No AI service is required.

A started case binds the entire input, observer configuration, room and credential. Editing any of these fails closed. Preserve the original files and `.case/` together. For a new case, archive the completed/inconclusive case deliberately and use a fresh working copy; never reuse old evidence under a changed runbook. This starter handles one case per checkout.

State and credentials use private directories and atomic writes. A local lock excludes concurrent commands; after a crash, confirm the recorded process has stopped before removing its `.lock` directory. Do not run one state directory across multiple hosts. Local files remain editable by their owner and are not tamper-proof audit evidence. Keep backups and restore corrupted state instead of resetting it.

`case.json`, `config.json`, `.env`, `.pingroom/` and `.case/` are ignored. Sample files under `examples/` are safe fixtures. Tests cover graph failures, chosen-path integrity, uncertain creation/recovery, storage and transport failures, invalid answers, environment precedence and CLI outcomes. Automated checks do not establish live phone delivery.

MIT licensed. Official references: [SDK repository](https://github.com/pingroom/sdk) and [PingRoom agent documentation](https://pingroom.io/agent.md).
