import { chromium, type Browser, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import "dotenv/config";

const SNAP_DIR = process.env.SCREENSHOT_DIR;

async function snap(page: Page, label: string) {
  if (!SNAP_DIR) return;
  await page.screenshot({ path: join(SNAP_DIR, `${label}.png`), fullPage: false });
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

// --- Zod schemas ---

const LotSizeSchema = z.object({
  value: z.number().nullable(),
  unit: z.string().nullable(),
}).nullable();

const AddressSchema = z.object({
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
});

const ListingSchema = z.object({
  zpid: z.string(),
  price: z.string().nullable(),
  unformattedPrice: z.number().nullable(),
  beds: z.number().nullable(),
  baths: z.number().nullable(),
  livingAreaSqft: z.number().nullable(),
  lotSize: LotSizeSchema,
  address: AddressSchema,
  propertyType: z.string().nullable(),
  listingStatus: z.string().nullable(),
  daysOnZillow: z.number().nullable(),
  zestimate: z.number().nullable(),
  hoaFee: z.null(),
  monthlyPayment: z.null(),
  primaryPhoto: z.string().nullable(),
  detailUrl: z.string().nullable(),
});

const OutputSchema = z.object({
  query: z.object({
    location: z.string(),
    regionSelection: z.array(z.object({ regionId: z.number(), regionType: z.number() })),
  }),
  totalResultCount: z.number().nullable(),
  returnedCount: z.number(),
  currentPage: z.number(),
  totalPages: z.number(),
  listings: z.array(ListingSchema),
});

// --- helpers ---

function extractNextData(html: string): any {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("__NEXT_DATA__ not found in response");
  return JSON.parse(match[1]);
}

function mapListing(r: any): z.infer<typeof ListingSchema> {
  const hi = r.hdpData?.homeInfo ?? {};
  return {
    zpid: String(r.zpid ?? hi.zpid ?? ""),
    price: r.price ?? null,
    unformattedPrice: r.unformattedPrice ?? hi.price ?? null,
    beds: r.beds ?? hi.bedrooms ?? null,
    baths: r.baths ?? hi.bathrooms ?? null,
    livingAreaSqft: r.area ?? hi.livingArea ?? null,
    lotSize: (hi.lotAreaValue != null)
      ? { value: hi.lotAreaValue, unit: hi.lotAreaUnit ?? "sqft" }
      : null,
    address: {
      street: r.addressStreet ?? hi.streetAddress ?? null,
      city: r.addressCity ?? hi.city ?? null,
      state: r.addressState ?? hi.state ?? null,
      zip: r.addressZipcode ?? hi.zipcode ?? null,
    },
    propertyType: hi.homeType ?? r.homeType ?? null,
    listingStatus: r.statusType ?? hi.homeStatus ?? null,
    daysOnZillow: hi.daysOnZillow ?? r.daysOnZillow ?? null,
    zestimate: r.zestimate ?? null,
    hoaFee: null,
    monthlyPayment: null,
    primaryPhoto: r.imgSrc ?? null,
    detailUrl: r.detailUrl
      ? (r.detailUrl.startsWith("http") ? r.detailUrl : `https://www.zillow.com${r.detailUrl}`)
      : null,
  };
}

async function main() {
  const session = createSession();
  let page!: Page;
  let browser!: Browser;

  try {
    ({ browser, page } = await connect(session.connectUrl));

    await snap(page, "01-start");

    // Build the filtered URL
    const searchQueryState = {
      isMapVisible: false,
      isListVisible: true,
      mapBounds: {
        west: -98.090558,
        east: -97.541748,
        south: 30.06787,
        north: 30.519484,
      },
      regionSelection: [{ regionId: 10221, regionType: 6 }],
      filterState: {
        isCondo: { value: true },
        isTownhouse: { value: true },
        isSingleFamily: { value: false },
        isMultiFamily: { value: false },
        isApartment: { value: false },
        isManufactured: { value: false },
        isLotLand: { value: false },
        price: { min: 300000, max: 700000 },
        beds: { min: 2 },
        baths: { min: 2 },
        sortSelection: { value: "globalrelevanceex" },
      },
      pagination: { currentPage: 1 },
    };

    const encodedQS = encodeURIComponent(JSON.stringify(searchQueryState));
    const targetUrl = `https://www.zillow.com/homes/Austin-TX_rb/?searchQueryState=${encodedQS}`;

    // Navigate via the browser (CDP session, with proxies already set at session creation)
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await snap(page, "02-page-loaded");

    // Extract __NEXT_DATA__ from the page
    let nextDataJson: any;
    try {
      const nextDataText = await page.evaluate(() => {
        const el = document.getElementById("__NEXT_DATA__");
        return el ? el.textContent : null;
      });
      if (!nextDataText) throw new Error("__NEXT_DATA__ element not found or empty");
      nextDataJson = JSON.parse(nextDataText);
    } catch (err) {
      // Fallback: try fetching via fetch from inside the page
      const html = await page.content();
      nextDataJson = extractNextData(html);
    }

    await snap(page, "03-data-extracted");

    const searchPageState = nextDataJson?.props?.pageProps?.searchPageState;
    if (!searchPageState) {
      // Check for captcha / block
      const title = await page.title();
      throw new Error(`searchPageState not found. Page title: "${title}". Possibly blocked.`);
    }

    const cat1 = searchPageState?.cat1;
    const listResults: any[] = cat1?.searchResults?.listResults ?? [];
    const totalResultCount: number | null = searchPageState?.categoryTotals?.cat1?.totalResultCount ?? null;

    const resolvedRegion = searchPageState?.queryState?.regionSelection ?? [{ regionId: 10221, regionType: 6 }];

    const listings = listResults.map(mapListing);

    const returnedCount = listings.length;
    const pageSize = 41;
    const currentPage = 1;
    const totalPages = totalResultCount != null ? Math.ceil(totalResultCount / pageSize) : 1;

    const output = OutputSchema.parse({
      query: {
        location: "Austin, TX",
        regionSelection: resolvedRegion,
      },
      totalResultCount,
      returnedCount,
      currentPage,
      totalPages,
      listings,
    });

    console.log(JSON.stringify({ success: true, data: output }));

  } catch (err: any) {
    await snap(page, "99-error");
    console.log(JSON.stringify({ success: false, error: String(err?.message ?? err) }));
    throw err;
  } finally {
    releaseSession(session.id);
  }
}

main();