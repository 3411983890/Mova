// Adapt the composer's existing semantic icon names to rounded Keyline icons.
import React from 'react';
import { Plus, ArrowUp, Stop, File, FileText, ListChecks, Target, Paperclip,
  Box, Folder, CircleCheck, Info, X } from '@keyline-icons/react';
const icons = { plus: Plus, 'arrow-up': ArrowUp, stop: Stop, file: File,
  'file-lines': FileText, 'list-check': ListChecks, bullseye: Target,
  paperclip: Paperclip, cube: Box, folder: Folder, 'circle-check': CircleCheck,
  'circle-info': Info, xmark: X };
export function FontAwesomeIcon({ icon, ...props }) {
  const name = Array.isArray(icon) ? icon[1] : icon?.iconName || icon;
  const Component = icons[name];
  return Component ? React.createElement(Component, { size: '1em', 'aria-hidden': true, ...props }) : null;
}
