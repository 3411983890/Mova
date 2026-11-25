// Isolated QA profile: never touches the user's actual Mova data.
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const profile = process.env.MOVA_QA_PROFILE || path.join(os.tmpdir(), 'mova-memory-smoke-profile');
app.setPath('userData', profile);
require('../../electron/main.cjs');
