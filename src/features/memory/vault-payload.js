/**
 * Wire shape for `vault:change-passphrase`. The main process reads
 * `input.oldPassphrase` and `input.nextPassphrase`, while the form state is
 * named `oldPassphrase` / `newPassphrase`. Building the payload here — instead
 * of inline in JSX — is what an earlier version got wrong: it passed a bare
 * `nextPassphrase` binding that was never declared, so every rotation sent an
 * undefined new passphrase.
 */
export function passphraseChangePayload(oldPassphrase, newPassphrase) {
  return { oldPassphrase, nextPassphrase: newPassphrase };
}
