// ============================================================
// NATHAN HOBBS — ROLLING JOB DIGEST (Adzuna Edition v6)
// Google Apps Script
//
// CHANGES FROM v5:
// 1. Remote filter no longer matches descriptions (was passing
//    "no remote work available"); checks location/title only,
//    with negation phrases excluded.
// 2. Local filter enforces the allowed city list in code instead
//    of accepting anything containing "virginia".
// 3. Adzuna query uses what_phrase + distance radius; added a
//    cheap title blocklist pre-filter before Claude.
// 4. Claude sees 1400 chars of description (was 400), prompt
//    defaults to EXCLUDE when ambiguous, max_tokens raised to 3000.
//
// SETUP INSTRUCTIONS:
// 1. Go to script.google.com and create a new project
// 2. Paste this entire file into the editor
// 3. Fill in your four credentials below
// 4. You need TWO triggers:
//    a) runHourlyJobSearch — Hour timer — Every hour (collects jobs)
//    b) sendDailyDigest    — Day timer  — 8am (sends the email)
// 5. Click Run > runHourlyJobSearch once manually to authorize permissions
//
// HOW IT WORKS:
// Every hour checks one location across all 4 role types, stores fits.
// Every morning at 8am Mon-Sat: compiles everything found since yesterday,
// sends one digest email, clears the stored results.
// No fits found = no email sent. Skips Sundays entirely.
//
// TO PAUSE: set ENABLED = false and save.
// ============================================================

var ANTHROPIC_API_KEY = "PLACEHOLDER";
var ADZUNA_APP_ID     = "PLACEHOLDER";
var ADZUNA_APP_KEY    = "PLACEHOLDER";
var MY_EMAIL          = "PLACEHOLDER";

// ============================================================
// KILL SWITCH
// ============================================================
var ENABLED = true;

// ============================================================
// BLOCKED DOMAINS — filtered before Claude sees results
// ============================================================
var BLOCKED_DOMAINS = [
  "ziprecruiter.com",
  "monster.com"
];

// ============================================================
// ALLOWED AREAS — local listings must match one of these
// ============================================================
var ALLOWED_AREAS = [
  "fredericksburg",
  "spotsylvania",
  "stafford",
  "caroline",
  "orange",
  "king george",
  "richmond",
  "midlothian",
  "manassas",
  "quantico",
  "woodbridge",
  "arlington",
  "alexandria"
];

// ============================================================
// TITLE BLOCKLIST — cheap pre-filter before Claude evaluation.
// Any title containing one of these is dropped immediately.
// ============================================================
var TITLE_BLOCKLIST = [
  "senior",
  "sr.",
  "sr ",
  "lead",
  "manager",
  "director",
  "supervisor",
  "tier 2",
  "tier 3",
  "tier ii",
  "tier iii",
  "level 2",
  "level 3",
  "level ii",
  "level iii",
  " ii",
  " iii",
  "principal",
  "architect",
  "engineer ii",
  "receptionist",
  "administrative assistant",
  "admin assistant",
  "clerk",
  "clerical",
  "front desk",
  "secretary",
  "nurse",
  "driver",
  "warehouse",
  "sales",
  "recruiter",
  "intern"
];

// ============================================================
// REMOTE NEGATION PHRASES — if a "remote" search result's
// description contains any of these, it is dropped.
// ============================================================
var REMOTE_NEGATIONS = [
  "no remote",
  "not remote",
  "not a remote",
  "remote work is not",
  "this is not a remote",
  "on-site only",
  "onsite only",
  "100% on-site",
  "100% onsite",
  "fully on-site",
  "fully onsite"
];

// ============================================================
// CANDIDATE PROFILE
// ============================================================
var CANDIDATE_PROFILE = `
Name: Nathan Hobbs
Location: Fredericksburg, Virginia

EXPERIENCE:
- IS Tech Support Specialist Intern, Mary Washington Healthcare (Oct-Dec 2025)
  - First-line IT support across 80+ medical centers
  - ServiceNow ticketing, remote and on-site troubleshooting
  - Windows 10/11 workstation support, hardware repair, pre-deployment image testing
  - Authored knowledge base documentation
  - Asset tracking, device retirement, lifecycle management
  - A/V support, Microsoft Teams setup
  - Helped automate Configuration Manager deployment (~10% time reduction)

- Technical Support Specialist & Data Associate, Key Media & Research (May 2021-June 2025)
  - Internal IT support for SaaS CMS and research systems
  - User account creation and workstation configuration during onboarding
  - WordPress/Elementor website redesign (50% pageviews increase, 60% user growth)
  - Data visualization using Flourish (130+ published visualizations)
  - Power BI dashboard (published to GitHub): 2025 Top 50 Contract Glaziers

- Supervisor / Head Media Intern, Seneca Hills Bible Camp (June 2019 - August 2019)
  - Supervised five team members across social media, content creation, and web optimization
  - Improved website load times by ~30% through image optimization and caching

EDUCATION:
- B.S. Media Arts & Design (Web Development concentration), James Madison University, 2021
- Minor in General Business

CERTIFICATIONS:
- CompTIA A+, Network+, Security+
- Microsoft AZ-900

SKILLS:
- Windows 10/11 troubleshooting, Microsoft 365, ServiceNow, hardware repair
- Data visualization: Flourish, Power BI
- Web: WordPress, HTML/CSS
- Technical writing and knowledge base documentation
- Basic networking (ping, tracert, nslookup)
- On-prem Active Directory (limited: password resets, account unlocks, device staging only)
- Cloud: Microsoft Entra ID lab (account provisioning, MFA, RBAC)

HONEST GAPS:
- No security clearance, not pursuing one
- macOS experience is limited
- Active Directory experience is very limited - do not credit roles requiring broad AD administration
- No Master's degree
- Not a receptionist, admin assistant, or clerical role - do not surface these
- Do not count data analyst roles wanting experience with Python, R, or other programming languages
- Not a Mid Level Tech Writer. Do not surface these. Entry level only

TARGET ROLES: IT Support/Helpdesk, Technical Writer, Junior Data Analyst, Data Visualization
TARGET LOCATIONS: Fredericksburg, Spotsylvania, Stafford, Caroline, Orange, King George,
  Richmond, Midlothian, Manassas, Quantico, Woodbridge, Arlington, or Remote (US)
SCHEDULE: Day shift only, standard 8-hour days, Monday-Friday preferred.
  Disqualify any role requiring Saturday/Sunday shifts or averaging less than 30 hours/week.
EMPLOYMENT TYPE: Full-time permanent preferred. Disqualify wage/hourly temp roles
  with hour caps or no benefits unless exceptionally strong fit.
`;

// ============================================================
// LOCATIONS — one processed per trigger run, cycling in order
// ============================================================
var LOCATIONS = [
  "Fredericksburg Virginia",
  "Spotsylvania Virginia",
  "Stafford Virginia",
  "Caroline Virginia",
  "Orange Virginia",
  "King George Virginia",
  "Richmond Virginia",
  "Midlothian Virginia",
  "Manassas Virginia",
  "Quantico Virginia",
  "Woodbridge Virginia",
  "Arlington Virginia",
  "" // Remote
];

// ============================================================
// ROLE KEYWORDS — all four searched per location per run
// ============================================================
var ROLE_KEYWORDS = [
  "IT Support",
  "Technical Writer",
  "Junior Data Analyst",
  "Data Visualization"
];

// ============================================================
// SUNDAY CHECK
// ============================================================
function isSunday() {
  return new Date().getDay() === 0;
}

// ============================================================
// COLLECT JOBS — runs every hour via trigger
// ============================================================
function runHourlyJobSearch() {
  if (!ENABLED) {
    Logger.log("Script is disabled.");
    return;
  }

  if (isSunday()) {
    Logger.log("Sunday — skipping collection.");
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var index = parseInt(props.getProperty("locationIndex") || "0");
  if (index >= LOCATIONS.length) index = 0;

  var location = LOCATIONS[index];
  var locationLabel = location || "Remote";
  Logger.log("Location " + (index + 1) + " of " + LOCATIONS.length + ": " + locationLabel);

  props.setProperty("locationIndex", String((index + 1) % LOCATIONS.length));

  // Fetch all four role types for this location
  var allListings = [];
  for (var i = 0; i < ROLE_KEYWORDS.length; i++) {
    var keyword = ROLE_KEYWORDS[i];
    Logger.log("Fetching: " + keyword + " / " + locationLabel);
    var results = fetchAdzunaListings(keyword, location);
    Logger.log("  Returned: " + results.length + " results");
    allListings = allListings.concat(results);
    Utilities.sleep(500);
  }

  Logger.log("Total listings before filtering: " + allListings.length);

  // Deduplicate by URL
  var seen = {};
  allListings = allListings.filter(function(job) {
    var url = job.redirect_url || "";
    if (seen[url]) return false;
    seen[url] = true;
    return true;
  });

  // Filter blocked domains
  allListings = allListings.filter(function(job) {
    var url = (job.redirect_url || "").toLowerCase();
    for (var i = 0; i < BLOCKED_DOMAINS.length; i++) {
      if (url.indexOf(BLOCKED_DOMAINS[i]) !== -1) return false;
    }
    return true;
  });

  // Title blocklist pre-filter — drop obvious non-fits before Claude
  allListings = allListings.filter(function(job) {
    var t = (job.title || "").toLowerCase();
    for (var i = 0; i < TITLE_BLOCKLIST.length; i++) {
      if (t.indexOf(TITLE_BLOCKLIST[i]) !== -1) {
        Logger.log("Title blocklist drop: " + job.title);
        return false;
      }
    }
    return true;
  });

  // Filter by location
  allListings = allListings.filter(function(job) {
    var jobLocation = (job.location ? job.location.display_name : "").toLowerCase();
    var jobTitle = (job.title || "").toLowerCase();
    var jobDesc = (job.description || "").toLowerCase();

    if (!location) {
      // Remote query — drop listings that explicitly negate remote work
      for (var n = 0; n < REMOTE_NEGATIONS.length; n++) {
        if (jobDesc.indexOf(REMOTE_NEGATIONS[n]) !== -1) return false;
      }
      // Only keep if location or title actually says remote
      return jobLocation.indexOf("remote") !== -1 ||
             jobTitle.indexOf("remote") !== -1;
    }

    // Local query — must match an explicitly allowed area
    for (var a = 0; a < ALLOWED_AREAS.length; a++) {
      if (jobLocation.indexOf(ALLOWED_AREAS[a]) !== -1) return true;
    }
    return false;
  });

  Logger.log("Listings after all filters: " + allListings.length);

  // Log what passed for debugging
  allListings.forEach(function(job) {
    Logger.log("Passed filter: " + (job.location ? job.location.display_name : "no location") + " — " + job.title);
  });

  if (allListings.length === 0) {
    Logger.log("No listings to evaluate.");
    return;
  }

  // Evaluate fit with Claude
  var fits = evaluateFit(allListings, locationLabel);
  Logger.log("Fit results: " + fits.length);

  if (fits.length === 0) {
    Logger.log("No fits found for " + locationLabel);
    return;
  }

  storeFits(fits);
}

// ============================================================
// STORE FITS between runs using PropertiesService
// ============================================================
function storeFits(newFits) {
  var props = PropertiesService.getScriptProperties();
  var existing = [];

  try {
    var stored = props.getProperty("pendingJobs");
    if (stored) existing = JSON.parse(stored);
  } catch (e) {
    existing = [];
  }

  var storedUrls = {};
  existing.forEach(function(job) { storedUrls[job.url] = true; });

  var added = 0;
  newFits.forEach(function(job) {
    if (!storedUrls[job.url]) {
      existing.push(job);
      added++;
    }
  });

  props.setProperty("pendingJobs", JSON.stringify(existing));
  Logger.log("Stored " + added + " new fit(s). Total pending: " + existing.length);
}

// ============================================================
// SEND DAILY DIGEST — runs once at 8am via separate trigger
// ============================================================
function sendDailyDigest() {
  if (!ENABLED) {
    Logger.log("Script is disabled.");
    return;
  }

  if (isSunday()) {
    Logger.log("Sunday — skipping digest.");
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var jobs = [];

  try {
    var stored = props.getProperty("pendingJobs");
    if (stored) jobs = JSON.parse(stored);
  } catch (e) {
    jobs = [];
  }

  if (jobs.length === 0) {
    Logger.log("No pending jobs. No email sent.");
    return;
  }

  Logger.log("Sending digest with " + jobs.length + " job(s).");
  sendDigestEmail(jobs);

  props.deleteProperty("pendingJobs");
  Logger.log("Pending jobs cleared.");
}

// ============================================================
// FETCH FROM ADZUNA — with one retry on 503
// ============================================================
function fetchAdzunaListings(keywords, location) {
  var base = "https://api.adzuna.com/v1/api/jobs/us/search/1";
  var params = {
    app_id:           ADZUNA_APP_ID,
    app_key:          ADZUNA_APP_KEY,
    results_per_page: 10,
    what_phrase:      keywords,
    sort_by:          "date",
    max_days_old:     3
  };

  if (location) {
    params.where = location;
    params.distance = 15; // miles — keeps each query tight to its city
  }

  var qs = Object.keys(params).map(function(k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
  }).join("&");

  var url = base + "?" + qs;

  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var code = response.getResponseCode();

      if (code === 200) {
        var data = JSON.parse(response.getContentText());
        return data.results || [];
      }

      if (code === 503 && attempt === 1) {
        Logger.log("Adzuna 503 on attempt 1 — retrying in 5 seconds...");
        Utilities.sleep(5000);
        continue;
      }

      Logger.log("Adzuna error " + code + " on attempt " + attempt);
      return [];

    } catch (e) {
      Logger.log("Adzuna fetch error (attempt " + attempt + "): " + e.toString());
      if (attempt === 1) Utilities.sleep(5000);
    }
  }

  return [];
}

// ============================================================
// EVALUATE FIT WITH CLAUDE
// ============================================================
function evaluateFit(listings, locationLabel) {
  var listingSummary = listings.map(function(job, i) {
    return (i + 1) + ". Title: " + (job.title || "N/A") +
           "\n   Company: " + (job.company ? job.company.display_name : "N/A") +
           "\n   Location: " + (job.location ? job.location.display_name : "N/A") +
           "\n   URL: " + (job.redirect_url || "N/A") +
           "\n   Description: " + (job.description || "").substring(0, 1400);
  }).join("\n\n");

  var prompt = `You are a job search assistant evaluating listings for a candidate.

CANDIDATE PROFILE:
${CANDIDATE_PROFILE}

HARD EXCLUSIONS — disqualify any posting that matches ANY of these:
- Requires a security clearance of any kind
- Requires a Master's degree
- Requires Saturday, Sunday, or rotating shifts
- Is a wage/temp role with hour caps or no benefits
- Requires 3+ years in a specialized skill the candidate clearly lacks
- Is a Tier 2, Level 2, Senior, Lead, or supervisory role
- Is a receptionist, admin assistant, clerical, or front desk role
- Is a staffing agency listing with no named end employer
- Requires deep Active Directory administration beyond basic account management
- Requires Python, R, or other programming languages for data analyst roles
- Is a Mid-Level or Senior Technical Writer role — entry level only
- Is located outside these specific areas: Fredericksburg, Spotsylvania, Stafford,
  Caroline, Orange, King George, Richmond, Midlothian, Manassas, Quantico, Woodbridge,
  Arlington, or Alexandria Virginia. Remote positions are acceptable regardless of
  listed location. Disqualify ANYTHING in another state or Virginia city not on this list.

JOB LISTINGS TO EVALUATE:
${listingSummary}

Be strict. When a listing is ambiguous, incomplete, or you cannot verify that it
passes every exclusion above, EXCLUDE it. A missed good job costs little; an
irrelevant job in the digest costs trust. Do not overstate qualifications.
Active Directory experience is very limited.

Return a JSON array only — no other text, no markdown. Each item:
- title: job title
- company: employer name
- location: job location or "Remote"
- url: the redirect_url from the listing
- reason: 1-2 sentences on why this is a good fit

If nothing fits, return: []`;

  var payload = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }]
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", options);
  var code = response.getResponseCode();
  var text = response.getContentText();

  if (code !== 200) {
    Logger.log("Claude API error " + code + ": " + text);
    return [];
  }

  var data = JSON.parse(text);
  var textContent = "";
  for (var i = 0; i < data.content.length; i++) {
    if (data.content[i].type === "text") textContent += data.content[i].text;
  }

  Logger.log("Raw Claude response: " + textContent.substring(0, 500));

  try {
    var clean = textContent.replace(/```json|```/g, "").trim();
    var start = clean.indexOf("[");
    var end = clean.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    return JSON.parse(clean.substring(start, end + 1)) || [];
  } catch (e) {
    Logger.log("JSON parse error: " + e.toString());
    return [];
  }
}

// ============================================================
// SEND EMAIL
// ============================================================
function sendDigestEmail(jobs) {
  var now = new Date();
  var dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "MMMM d, yyyy");
  var count = jobs.length;
  var subject = "Job Digest — " + count + " Fit" + (count > 1 ? "s" : "") + " — " + Utilities.formatDate(now, Session.getScriptTimeZone(), "MMM d");

  var body = "JOB DIGEST — " + dateStr + "\n" + "=".repeat(60) + "\n\n";

  var html = "<div style='font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;'>";
  html += "<h2 style='color: #1a3a5c;'>Job Digest — " + dateStr + "</h2>";
  html += "<p style='color: #777; font-size: 13px;'>Roles: IT Support &bull; Technical Writer &bull; Junior Data Analyst &bull; Data Visualization</p>";
  html += "<hr style='border: 1px solid #ddd;'>";

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var title = job.title || "Untitled";
    var company = job.company || "Unknown";
    var location = job.location || "Unknown";
    var url = job.url || "#";
    var reason = job.reason || "";

    body += (i + 1) + ". " + title + "\n   " + company + " — " + location + "\n   " + url + "\n   " + reason + "\n\n";

    html += "<div style='margin: 20px 0; padding: 16px; border-left: 4px solid #1a3a5c; background: #f9f9f9;'>";
    html += "<h3 style='margin: 0 0 4px 0;'><a href='" + url + "' style='color: #1a3a5c; text-decoration: none;'>" + title + "</a></h3>";
    html += "<p style='margin: 0 0 8px 0; color: #555; font-size: 14px;'>" + company + " &mdash; " + location + "</p>";
    html += "<p style='margin: 0 0 10px 0; color: #333; font-size: 14px;'>" + reason + "</p>";
    html += "<a href='" + url + "' style='display: inline-block; padding: 6px 14px; background: #1a3a5c; color: white; text-decoration: none; border-radius: 4px; font-size: 13px;'>View Posting</a>";
    html += "</div>";
  }

  html += "<hr style='border: 1px solid #ddd; margin-top: 30px;'>";
  html += "<p style='color: #bbb; font-size: 12px;'>Daily Job Digest — searches run every hour Mon-Sat. Email delivers at 8am.</p>";
  html += "</div>";

  GmailApp.sendEmail(MY_EMAIL, subject, body, { htmlBody: html });
  Logger.log("Email sent: " + subject);
}

// ============================================================
// UTILITIES
// ============================================================
function resetLocationIndex() {
  PropertiesService.getScriptProperties().setProperty("locationIndex", "0");
  Logger.log("Location index reset to 0.");
}

function clearPendingJobs() {
  PropertiesService.getScriptProperties().deleteProperty("pendingJobs");
  Logger.log("Pending jobs cleared.");
}

function viewPendingJobs() {
  var stored = PropertiesService.getScriptProperties().getProperty("pendingJobs");
  if (!stored) {
    Logger.log("No pending jobs.");
    return;
  }
  var jobs = JSON.parse(stored);
  Logger.log(jobs.length + " pending job(s):");
  jobs.forEach(function(job, i) {
    Logger.log((i + 1) + ". " + job.title + " — " + job.company + " (" + job.location + ")");
  });
}
