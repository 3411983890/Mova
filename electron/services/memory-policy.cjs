'use strict';
// Single source of truth for whether automatic extraction may run. Both the
// PostgreSQL repository and the legacy JSON repository use this function so
// their behavior cannot drift again.
function shouldAutoExtract(settings) {
  return Boolean(settings)
    && settings.memoryEnabled === true
    && settings.autoExtract === true
    && settings.extractorMode !== 'off';
}

module.exports = { shouldAutoExtract };
