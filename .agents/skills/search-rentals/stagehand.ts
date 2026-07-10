import { Stagehand } from "@browserbasehq/stagehand";
import { join } from "node:path";
import { z } from "zod";
import "dotenv/config";

async function snap(page: any, label: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  await page.screenshot({
    path: join(dir, `${label}.png`),
    fullPage: false,
  });
}

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

async function main() {
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    model: {
      modelName: "anthropic/claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
  });

  await stagehand.init();
  const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

  try {
    const url = "https://www.apartments.com/chicago-il/under-2500/";

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    await snap(page, "01-landing");

    // Check for access denied
    const title = await page.title();
    if (title.toLowerCase().includes("access denied") || title.toLowerCase().includes("pardon our interruption")) {
      // Try reload once
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);
      await snap(page, "02-after-reload");

      const title2 = await page.title();
      if (title2.toLowerCase().includes("access denied") || title2.toLowerCase().includes("pardon our interruption")) {
        const result = OutputSchema.parse({
          success: false,
          location: "Chicago, IL",
          filters: { max_price: 2500 },
          total_results: null,
          result_count_on_page: 0,
          listings: [],
          error_reasoning: `Access denied by Akamai Bot Manager. Page title: "${title2}"`,
        });
        console.log(JSON.stringify(result));
        return;
      }
    }

    // Wait for listing cards to appear
    try {
      await page.waitForSelector("article.placard", { timeout: 15000 });
    } catch {
      await snap(page, "03-no-placards");
    }

    await snap(page, "03-listings-loaded");

    // Extract listings via eval
    const evalResult = await page.evaluate(() => {
      const out: {
        total_results: number | null;
        listings: Array<{
          name: string | null;
          address: string | null;
          url: string | null;
          rent: string | null;
          beds: string | null;
          baths: null;
          phone: string | null;
        }>;
        result_count_on_page: number;
      } = { total_results: null, listings: [], result_count_on_page: 0 };

      const m = (document.title || "").match(/([\d,]+)\s+Rentals/i);
      if (m) out.total_results = parseInt(m[1].replace(/,/g, ""));

      for (const card of document.querySelectorAll("article.placard")) {
        const nameEl = card.querySelector(".js-placardTitle, .title");
        const name = nameEl ? nameEl.textContent : null;

        const addressEl = card.querySelector(".property-address");
        const address = addressEl ? addressEl.textContent : null;

        const link = card.querySelector("a.property-link") as HTMLAnchorElement | null;
        const url = link ? link.href.replace(/#.*$/, "").replace(/\?.*$/, "") : null;

        const beds: string[] = [];
        const prices: string[] = [];
        for (const box of card.querySelectorAll(".bedRentBox")) {
          const b = box.querySelector(".bedTextBox");
          const p = box.querySelector(".priceTextBox");
          if (b) beds.push((b.textContent || "").trim());
          if (p) prices.push((p.textContent || "").trim());
        }

        const nums = prices.map((p) => parseInt(p.replace(/[^\d]/g, ""))).filter((n) => !isNaN(n) && n > 0);
        let rent: string | null = null;
        if (nums.length === 1) rent = prices[0];
        else if (nums.length > 1) rent = "$" + Math.min(...nums).toLocaleString() + " - $" + Math.max(...nums).toLocaleString();

        const bedRange = beds.length === 1 ? beds[0] : beds.length > 1 ? beds[0] + " - " + beds[beds.length - 1] : null;

        const phoneEl = card.querySelector(".phone-link span, a.phone-link");
        const phone = phoneEl ? (phoneEl.textContent || "").trim() : null;

        if (name || url) {
          out.listings.push({
            name: name ? name.trim() : null,
            address: address ? address.trim() : null,
            url,
            rent,
            beds: bedRange,
            baths: null,
            phone: phone || null,
          });
        }
      }

      out.result_count_on_page = out.listings.length;
      return out;
    });

    await snap(page, "04-extracted");

    if (!evalResult || evalResult.listings.length === 0) {
      // Try to get more info
      const pageTitle = await page.title();
      const result = OutputSchema.parse({
        success: false,
        location: "Chicago, IL",
        filters: { max_price: 2500 },
        total_results: null,
        result_count_on_page: 0,
        listings: [],
        error_reasoning: `No listings found. Page title: "${pageTitle}". The page may be blocking the scraper or showing a captcha.`,
      });
      console.log(JSON.stringify(result));
      return;
    }

    const result = OutputSchema.parse({
      success: true,
      location: "Chicago, IL",
      filters: { max_price: 2500 },
      total_results: evalResult.total_results,
      result_count_on_page: evalResult.result_count_on_page,
      listings: evalResult.listings,
      error_reasoning: null,
    });

    console.log(JSON.stringify(result));
  } catch (err) {
    await snap(page, "99-error");
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ success: false, error: errMsg }));
  } finally {
    await stagehand.close();
  }
}

main();