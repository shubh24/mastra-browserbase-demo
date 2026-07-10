/**
 * browse.sh catalog skill: `craigslist-search-listings`.
 *
 * Faithful to the published skill — leads with the public JSON API at
 * sapi.craigslist.org (recommended_method: "api"), with the documented
 * batch / Referer params. This is the "compose a catalog skill" leg of the
 * relocation concierge: real apartment listings in the user's new city.
 */

export interface Listing {
  postingId: number;
  title: string;
  price: string;
  beds: number | null;
  lat: number | null;
  lon: number | null;
}

export interface SearchArgs {
  /** craigslist subdomain, e.g. "sfbay", "newyork" */
  city: string;
  /** search path incl. optional subarea, e.g. "sfc/apa" (SF-proper apartments) */
  searchPath: string;
  query: string;
  limit?: number;
}

/** Decode craigslist's compact v8 item array into a flat Listing. */
function decode(item: any[]): Listing {
  const postingId = Number(item[0]);
  const priceTuple = item.find(
    (x) => typeof x === 'object' && Array.isArray(x) && x[0] === 10,
  )?.[1];
  const price =
    priceTuple ??
    (typeof item[3] === 'number' && item[3] > 0
      ? `$${item[3].toLocaleString()}`
      : 'price on request');
  // the title is the human string — by far the longest bare string (the others
  // are the "lat~lon" geo token and a short hex color code).
  const title =
    item
      .filter((x): x is string => typeof x === 'string' && !x.includes('~'))
      .sort((a, b) => b.length - a.length)[0] ?? '(untitled)';
  const bedsTuple = item.find(
    (x) => Array.isArray(x) && x[0] === 5 && x.length >= 2,
  );
  const beds = bedsTuple ? Number(bedsTuple[1]) : null;

  let lat: number | null = null;
  let lon: number | null = null;
  const geo = item.find((x) => typeof x === 'string' && x.includes('~'));
  if (geo) {
    const parts = geo.split('~');
    lat = Number(parts[1]) || null;
    lon = Number(parts[2]) || null;
  }
  return { postingId, title, price, beds, lat, lon };
}

export async function searchListings(args: SearchArgs): Promise<Listing[]> {
  const { city, searchPath, query, limit = 8 } = args;
  const url =
    `https://sapi.craigslist.org/web/v8/postings/search/full` +
    `?searchPath=${encodeURIComponent(searchPath)}` +
    `&query=${encodeURIComponent(query)}` +
    `&sort=date&batch=1-0-360-1-0&lang=en&cc=us`;

  const res = await fetch(url, {
    headers: {
      Referer: `https://${city}.craigslist.org/`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  if (!res.ok) throw new Error(`craigslist API ${res.status}`);
  const json: any = await res.json();
  const items: any[] = json?.data?.items ?? [];
  return items
    .filter((it) => Array.isArray(it))
    .slice(0, limit)
    .map(decode);
}
