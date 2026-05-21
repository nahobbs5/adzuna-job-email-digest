# Automated Job Search Pipeline

A self-contained Google Apps Script that runs a rolling job search, evaluates listings for candidate fit using the Claude API, and delivers a daily digest email with matched results.

---

## How It Works

**Every hour (Mon–Sat):** The script queries the Adzuna Jobs API across one location in a rotating list, searching all configured role types. Results are deduplicated, filtered for blocked domains and geographic scope, then passed to Claude (Haiku) for fit evaluation against a detailed candidate profile. Matched listings are stored in PropertiesService for later retrieval.

**Every morning at 8am (Mon–Sat):** A separate trigger compiles all stored matches since the last digest, sends a formatted HTML email, and clears the queue. If nothing matched overnight, no email is sent.

Sundays are skipped entirely — no collection, no email.

---

## Features

- **Multi-location rotation** — cycles through a configurable list of target locations one at a time per run, keeping API usage predictable
- **Multi-role search** — queries all configured role keywords per location per run
- **Claude-powered fit evaluation** — structured candidate profile and hard exclusion rules passed to the API; returns JSON array of matches with reasoning
- **Cross-run persistence** — matched jobs accumulate in PropertiesService between hourly runs and are cleared after the morning digest
- **Deduplication** — by URL, both within a single run and across stored results
- **Domain blocking** — configurable list of job board domains to exclude before Claude sees the results
- **Retry logic** — single retry with delay on Adzuna 503 responses
- **Kill switch** — set `ENABLED = false` to pause all collection and sending without removing triggers

---

## Setup

### 1. Create a Google Apps Script project

Go to [script.google.com](https://script.google.com), create a new project, and paste the full script into the editor.

### 2. Add your credentials

At the top of the file, fill in the four placeholders:

```javascript
var ANTHROPIC_API_KEY = "your-anthropic-api-key";
var ADZUNA_APP_ID     = "your-adzuna-app-id";
var ADZUNA_APP_KEY    = "your-adzuna-app-key";
var MY_EMAIL          = "your@email.com";
```

- **Anthropic API key:** [console.anthropic.com](https://console.anthropic.com)
- **Adzuna credentials:** [developer.adzuna.com](https://developer.adzuna.com) — free tier is sufficient

### 3. Customize your profile and targets

Edit `CANDIDATE_PROFILE` with your background, skills, and honest gaps. The more specific you are, the better Claude's fit evaluation will be.

Edit `LOCATIONS` and `ROLE_KEYWORDS` to match your target search.

### 4. Set up two triggers

In the Apps Script editor, go to **Triggers** (clock icon) and create:

| Function | Trigger type | Frequency |
|---|---|---|
| `runHourlyJobSearch` | Time-driven — Hour timer | Every 1 hour |
| `sendDailyDigest` | Time-driven — Day timer | 8am (your timezone) |

### 5. Authorize and test

Click **Run → runHourlyJobSearch** once manually. Apps Script will prompt you to authorize Gmail and URL fetch permissions. After authorizing, check the Logs to confirm the script ran without errors.

---

## Utility Functions

These can be run manually from the Apps Script editor for debugging and maintenance:

| Function | What it does |
|---|---|
| `viewPendingJobs()` | Logs all currently stored matches |
| `clearPendingJobs()` | Wipes the pending queue without sending |
| `resetLocationIndex()` | Resets the location rotation back to index 0 |

---

## Project Structure

```
├── AdzunaDailyJobs.js     # Full script — all logic in one file
└── README.md
```

All state is managed via Google Apps Script's `PropertiesService`. No external database or storage required.

---

## Notes

- The script uses `claude-haiku-4-5-20251001` for fit evaluation — fast and cost-efficient for high-frequency runs
- Adzuna's free tier allows 250 requests/day (25/minute, 1,000/week, 2,500/month); at 4 role keywords × ~13 locations that's 52 calls per hourly run, well within the daily limit with headroom for multiple cycles
- PropertiesService has a 500KB storage limit — the pending jobs queue is cleared daily, so this is not a concern under normal operation
