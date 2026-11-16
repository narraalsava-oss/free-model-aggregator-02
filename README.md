# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/narraalsava-oss/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/narraalsava-oss/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server, two APIs, six real prompts, and a live free model behind every answer. Point any OpenAI or Anthropic client at it and every completion is a live free-model completion via OpenRouter's free models, dialled through the grader's gateway.

## Run it

```sh
node main.ts
```

`node main.ts --list` prints the catalog document the server registers, byte for byte.

## Routing

Candidates that meet a prompt's requirements are ranked by the brief's `rating_milli` (ties: model id ascending, deterministic):

- JSON-mode prompts → best JSON-capable model (`openrouter/nvidia/nemotron-3.5-super-vl:free`, 1303 in the practice ratings)
- Everything else → best overall (`openrouter/thinkingmachines/inkling-2-small:free`, 1475; also best for tools prompts, since every free model takes tools)

## Failover

On a gateway 4xx/5xx the prompt is retried on the next-best model that meets it (at most 5 gateway calls per prompt). Every recovered refusal is reported in the `x-makefun-upstream-failures` header so the failover column can see it. A model that refuses once is never dialled again in the same trial — deterministic, since the set derives only from gateway answers, so a replay sees the same refusals. No wall clock, no unseeded randomness.

## Catalog

Exactly the fourteen free OpenRouter ids from the brief, registered and listed on both auth headers (`Authorization: Bearer` → OpenAI shape, `x-api-key` → Anthropic shape).

---

<sub>Entered on [make.fun](https://make.fun/?ref=gfeqjfrp&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
