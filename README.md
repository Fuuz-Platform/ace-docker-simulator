# ace-docker-simulator

> **Fuuz Industrial Operations Platform — ACE Docker Simulator**
> Version: `1.0.0` | Docs: **https://accelerators.fuuz.com/ace-docker-simulator/**

A running plant, a real industrial historian and a Fuuz-shaped GraphQL API, on your laptop, in one
command. Part of **ACE** (Auto Contextualization Engine) from the
[Fuuz Industrial Operations Platform](https://fuuz.com).

```bash
git clone https://github.com/Fuuz-Platform/ace-docker-simulator
cd ace-docker-simulator
docker compose up -d           # 5 containers, no configuration
open http://localhost:8081
```

No account, no tenant and no config file are needed for the simulator. Docker is the only
prerequisite.

---

## What runs

| Service | Port | Does |
|---|---|---|
| `ace-sim` | 4840, 4841 | OPC UA server — 8 units × 11 signals (88 tags), process/discrete/counter/enum/string, with rotating COMMS/STALE/FLATLINE/DRIFT faults that emit real OPC UA status codes |
| `ace-mongo` | 27017 | MongoDB with `mongot` bundled — the time-series store, and `$vectorSearch` |
| `ace-graphql` | 8098 | Fuuz-shaped GraphQL API over Mongo, plus the historian query surface |
| `ace-bridge` | 4842 | OPC UA subscription → historian: deadband, plus a sample on every quality edge |
| `ace-ui` | 8081 | Operations console (React behind nginx, which proxies every service under `/api/*`) |
| `ace-loadgen` | — | **Opt-in** (`--profile load`) — high-rate writer for sizing work |
| `ace-orchestrator` | 8099 | **Opt-in** (`--profile fuuz`) — ACE match + classify against a live Fuuz tenant |

The two opt-in services need something only you can supply — a tenant and a token for the
orchestrator, and a deliberate decision to generate load for the loadgen — so neither starts by
default.

## Why the historian is not just a table of numbers

`tagValue` is a native MongoDB time-series collection. What makes it a historian, in
[`graphql/historian.js`](graphql/historian.js):

| Capability | Why it is not optional |
|---|---|
| **Quality on every sample** | Bad samples are **stored**, not dropped — discarding them hides outages and makes coverage a lie. Aggregates exclude them and count them separately. |
| **Two timestamps** (`ts` source, `rt` receive) | The difference is late arrival. Store-and-forward replays hours-old samples out of order after a WAN outage; `latencyMs` makes that visible. |
| **Typed values** (`v` / `vb` / `vs`) | `Running=1` and `Speed=1.0` are not the same kind of fact. |
| **Interpolation mode per tag** | Continuous interpolates, discrete holds. Linear interpolation of a state signal invents states that never happened. |
| **Time-weighted aggregates** | Exception-based samples are irregular, so an arithmetic mean over-weights whatever was sampled often. Discrete tags get state durations and transition counts instead. |

Verified on simulator data:

```
PROCESS   Plant/PKG/TEM-001/Temp     arithmetic 121.332   TIME-WEIGHTED 121.589  <- preferred
DISCRETE  Plant/UTL/RUN-001/Running  ON 143s  OFF 37s  on-fraction 79.7%  transitions 6
```

### Throughput and sizing

Measured on an Apple M5 Max with `--profile load`:

```
20,000 tags @ 25,000/s target  ->  24,415/s sustained, 0 errors
14.45M samples stored          ->  6.1 bytes/sample on disk (2.1x compression)
quality mix: 99.18% Good · 0.22% Bad/NotConnected · 0.22% Uncertain/Stale · 0.10% Bad/OutOfRange
```

Tune with `LOADGEN_TAGS`, `LOADGEN_RATE`, `LOADGEN_BATCH_MS`.

## Pointing ACE at a live Fuuz tenant

```bash
cp .env.example .env      # fill in FUUZ_HOST, FUUZ_TENANT, FUUZ_TOKEN
docker compose --profile fuuz up -d
curl localhost:8099/health
```

| Route | Does |
|---|---|
| `GET /health` | probes every dependency (Fuuz data API, embeddings, vectors, LLM) |
| `POST /match` | Tier-1 deterministic pass over PENDING candidates |
| `POST /classify` | measurement type + role for every candidate |
| `POST /embed` | embeds tag paths into MongoDB (the Tier-2 recall lane) |
| `POST /similar` | `{"q":"chiller vibration"}` — semantic search over live tag paths |
| `POST /pipeline` | Tier 1, then the LLM **on the ambiguous band only** |

The last row is the important one. `NO_MATCH` is a Tier-1 **rejection**, and forwarding a rejection
to a language model lets the model overturn it — which it will, confidently. Only the genuinely
ambiguous band is routed, and every run reports what was withheld and why. The guardrail is not in
the model, it is in what you route to it.

### Inference

Defaults assume **Docker Model Runner**, which runs the model host-side on llama.cpp and so gets
the GPU a Docker Desktop container never can:

```bash
docker model pull hf.co/ggml-org/bge-m3-Q8_0-GGUF
docker model pull ai/qwen3
```

Measured on 44 strings, same 1024-d model: Docker Model Runner (Metal) **6.4 ms/string** · host LM
Studio 9.7 · CPU container 20.9.

> **Do not substitute `multilingual-e5-small`.** Every GGUF build of it has a broken tokenizer that
> returns bit-identical vectors for distinct CamelCase inputs (cosine 1.000000 for `MotorTemp` vs
> `BatchId`). It does not error — it returns well-formed unit-norm vectors — so it silently poisons
> the index. CamelCase is exactly what every OPC UA tag leaf is.

## Repository layout

```
docker-compose.yml     the stack
docker/                Dockerfiles + the nginx config that fronts the console
simulator/             OPC UA plant server
graphql/               Fuuz-shaped GraphQL API + historian
bridge/                OPC UA subscription -> historian
loadgen/               high-rate writer
orchestrator/          ACE HTTP surface (opt-in)
core/kernel/           ACE match + classify kernels — dependency-free
docdrop/               unstructured-document ingestion used by the orchestrator
site/                  the published documentation site
```

## Licence

No open-source licence is granted. © Fuuz. Published for Fuuz customers, partners and evaluators.

## Service levels

No service level agreement applies to anything published here. It becomes a supported
deliverable only once it has been implemented by a Fuuz services professional or an
approved Fuuz partner.
