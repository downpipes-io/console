## What this changes

A short description of the change and why.

## Checklist

- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] `npm run validate` passes (it includes the CSP-hash and bundle-drift gates) when
      `src/` or `public/app.js` changed.
- [ ] The bundle was rebuilt if `src/app.ts` or anything it imports changed, so the
      committed `public/app.js` matches the source.
- [ ] No custody change: the console still calls only the in-account engine admin API
      and never sends a key or customer data to the vendor.
- [ ] House style holds for any copy: Australian English, no em dashes.
- [ ] Every commit is signed off (`git commit -s`) for the Developer Certificate of
      Origin.

## Notes for reviewers
