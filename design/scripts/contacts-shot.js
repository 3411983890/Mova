// Opens the contacts view and selects a bot so the profile can be screenshotted.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const button = document.querySelector('#contacts-button');
if (!button) throw new Error('contacts button missing');
button.click();
await wait(500);
const rows = [...document.querySelectorAll('.contacts-row')];
if (!rows.length) throw new Error('no bot rows rendered');
rows[2]?.click();
await wait(600);
return { rows: rows.length, title: document.querySelector('.contacts-hero h2')?.textContent ?? null };
