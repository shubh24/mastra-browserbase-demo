/**
 * The "act on the user's behalf" leg: drive the browse CLI to fill + submit a
 * rental application on a public web form.
 *
 * DRY-RUN target: httpbin.org/forms/post — a public, reliably-reachable form
 * that echoes back exactly what it received. That echo lets us PROVE the live
 * site got the real SSN/email while the model/trace only ever saw a vault
 * token. (It's a stand-in for a real rental-application form — swap APPLY_URL
 * once we settle the long-term target.)
 *
 * Field map (httpbin form  ->  rental application):
 *   custname  <- applicant full name        (PII, redacted in traces)
 *   custtel   <- {{vault.phone}}            (secret substitution)
 *   custemail <- {{vault.email}}            (secret substitution)
 *   comments  <- "...; SSN {{vault.ssn}}"   (secret substitution inside text)
 */
import { BrowseSession } from '../browse-cli.js';
import { Vault } from '../pii.js';

export const APPLICATION_URL =
  process.env.APPLY_URL || 'https://httpbin.org/forms/post';

export interface ApplyInput {
  userId: string;
  applicantName: string;
  phoneToken: string;
  emailToken: string;
  ssnToken: string;
  income: string;
  moveIn: string;
}

export interface ApplyResult {
  submitted: boolean;
  applicationId: string | null;
  modelVisiblePayload: Record<string, string>;
  siteReceivedRealSsn: boolean;
  browserActions: Array<{ cmd: string; arg?: string }>;
}

export async function applyToApartment(
  input: ApplyInput,
  vault: Vault,
  onBrowserAction: (a: { cmd: string; arg?: string }) => void,
): Promise<ApplyResult> {
  // Per-user isolated cloud session — cookies/storage never cross users.
  const session = await BrowseSession.openIsolated(`reloc-${input.userId}`, APPLICATION_URL);

  try {
    // CSS selectors (httpbin field names) — robust, no snapshot needed.
    const comments = `Move-in ${input.moveIn}. Income ${input.income}. SSN ${input.ssnToken}`;

    await session.fill('input[name=custname]', input.applicantName);
    await session.fillSecret('input[name=custtel]', input.phoneToken, vault);
    await session.fillSecret('input[name=custemail]', input.emailToken, vault);
    await session.fillSecret('textarea[name=comments]', comments, vault);
    await session.click('button');

    const echo = await session.getText(); // httpbin echoes the submitted form

    // proof WITHOUT leaking: resolve at the boundary, check containment, return bool
    const realSsn = vault.resolve(input.ssnToken);

    session.actions.forEach(onBrowserAction);

    return {
      submitted: /"form"/.test(echo) || /custname/.test(echo),
      applicationId: null,
      modelVisiblePayload: {
        custname: input.applicantName,
        custtel: input.phoneToken,
        custemail: input.emailToken,
        comments,
      },
      siteReceivedRealSsn: echo.includes(realSsn),
      browserActions: session.actions,
    };
  } finally {
    await session.close();
  }
}
