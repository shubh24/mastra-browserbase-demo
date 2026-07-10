import { chromium, type Browser, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import "dotenv/config";

const ListingSchema = z.object({
  name: z.string().nullable(),
  address: z.string().nullable(),
  rent: z.string().nullable(),
  beds: z.string().nullable(),
  baths: z.string().nullable(),
  phone: z.string().nullable(),
  url: z.string().nullable(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  location: z.string(),
  filters: z.object({ max_price: z.number() }),
  total_results: z.number().nullable(),
  result_count_on_page: z.number(),
  listings: z.array(ListingSchema),
  error_reasoning: z.string().nullable(),
});

async function snap(page: Page, label: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  await page.screenshot({
    path: join(dir, `${label}.png`),
    fullPage: false,
  });
}

function createSession() {
  const stdout = execFileSync("browse", [
    "cloud", "sessions", "create",
    "--keep-alive", "--verified", "--proxies",
  ]).toString();
  return JSON.parse(stdout) as { id: string; connectUrl: string };
}

async function connect(connectUrl: string) {
  const browser = await chromium.connectOverCDP(connectUrl);
  const [context] = browser.contexts();
  const page = context.pages()[0] ?? await context.newPage();
  return { browser, page };
}

function releaseSession(sessionId: string) {
  execFileSync("browse", [
    "cloud", "sessions", "update", sessionId,
    "--status", "REQUEST_RELEASE",
  ]);
}

const EXTRACT_SCRIPT = `(() => {
  const out = { total_results: null, listings: [] };
  const m = (document.title || '').match(/([\\d,]+)\\s+Rentals/i);
  if (m) out.total_results = parseInt(m[1].replace(/,/g, ''));
  for (const card of document.querySelectorAll('article.placard')) {
    const name = (card.querySelector('.js-placardTitle, .title') || {}).textContent;
    const address = (card.querySelector('.property-address') || {}).textContent;
    const link = card.querySelector('a.property-link');
    const url = link ? link.href.replace(/#.*$/, '').replace(/\\?.*$/, '') : null;
    const beds = [], prices = [];
    for (const box of card.querySelectorAll('.bedRentBox')) {
      const b = box.querySelector('.bedTextBox'), p = box.querySelector('.priceTextBox');
      if (b) beds.push(b.textContent.trim());
      if (p) prices.push(p.textContent.trim());
    }
    const nums = prices.map(p => parseInt(p.replace(/[^\\d]/g, ''))).filter(n => n);
    let rent = null;
    if (nums.length === 1) rent = prices[0];
    else if (nums.length > 1) rent = '$' + Math.min(...nums).toLocaleString() + ' - $' + Math.max(...nums).toLocaleString();
    const bedRange = beds.length === 1 ? beds[0] : (beds.length > 1 ? beds[0] + ' - ' + beds[beds.length - 1] : null);
    const phone = (card.querySelector('.phone-link span, a.phone-link') || {}).textContent;
    if (name || url) out.listings.push({
      name: name ? name.trim() : null,
      address: address ? address.trim() : null,
      url,
      rent,
      beds: bedRange,
      baths: null,
      phone: phone ? phone.trim() : null
    });
  }
  out.result_count_on_page = out.listings.length;
  return JSON.stringify(out);
})()`;

async function main() {
  const session = createSession();
  let page: Page | null = null;
  let currentStep = "init";

  try {
    const conn = await connect(session.connectUrl);
    page = conn.page;

    currentStep = "navigate";
    const targetUrl = "https://www.apartments.com/chicago-il/under-2500/";
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await snap(page, "01-landing");

    // Check for Access Denied and reload if needed
    let title = await page.title();
    if (title.toLowerCase().includes("access denied") || title.toLowerCase().includes("pardon our interruption")) {
      currentStep = "reload-after-access-denied";
      await page.waitForTimeout(3000);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(5000);
      await snap(page, "02-after-reload");
      title = await page.title();
    }

    if (title.toLowerCase().includes("access denied") || title.toLowerCase().includes("pardon our interruption")) {
      const output = OutputSchema.parse({
        success: false,
        location: "Chicago, IL",
        filters: { max_price: 2500 },
        total_results: null,
        result_count_on_page: 0,
        listings: [],
        error_reasoning: `Access Denied / Akamai block detected. Page title: "${title}"`,
      });
      console.log(JSON.stringify({ success: false, data: output }));
      return;
    }

    // Wait for placards to render
    currentStep = "wait-for-placards";
    try {
      await page.waitForSelector("article.placard", { timeout: 30000 });
    } catch {
      // If no placards after 30s, try waiting a bit more
      await page.waitForTimeout(5000);
    }
    await snap(page, "03-placards-loaded");

    // Extract data
    currentStep = "extract";
    const rawResult = await page.evaluate(EXTRACT_SCRIPT);
    const parsed = JSON.parse(rawResult as string) as {
      total_results: number | null;
      result_count_on_page: number;
      listings: Array<{
        name: string | null;
        address: string | null;
        url: string | null;
        rent: string | null;
        beds: string | null;
        baths: string | null;
        phone: string | null;
      }>;
    };

    await snap(page, "04-extracted");

    if (parsed.listings.length === 0) {
      // Try alternate approach — check page for any indication of what went wrong
      const pageTitle = await page.title();
      const output = OutputSchema.parse({
        success: false,
        location: "Chicago, IL",
        filters: { max_price: 2500 },
        total_results: parsed.total_results,
        result_count_on_page: 0,
        listings: [],
        error_reasoning: `No listing placards found. Page title: "${pageTitle}"`,
      });
      console.log(JSON.stringify({ success: false, data: output }));
      return;
    }

    const output = OutputSchema.parse({
      success: true,
      location: "Chicago, IL",
      filters: { max_price: 2500 },
      total_results: parsed.total_results,
      result_count_on_page: parsed.result_count_on_page,
      listings: parsed.listings,
      error_reasoning: null,
    });

    console.log(JSON.stringify({ success: true, data: output }));
  } catch (err) {
    if (page) {
      await snap(page, `99-error-at-${currentStep}`);
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ success: false, error: errMsg }));
    throw err;
  } finally {
    releaseSession(session.id);
  }
}

main();