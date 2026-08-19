// Mint a valid TOTP code for a secret, the way an authenticator app would.
//
// Kept in one place deliberately: otplib 12 -> 13 removed the `authenticator`
// export the tests had each been calling directly, so a single dependency bump
// broke five test files at once. Everything now goes through here.
import { generateSync } from "otplib";

export function totpCode(secret: string): string {
  return generateSync({ secret });
}
