import type { Toolkit } from '@assistant-ui/react';
import { nativeToolkit } from './nativeToolkit/nativeToolkit';
import { customToolkit } from './customToolkit/customToolkit';
// import { approvalToolkit } from './approval-tools'; // Not needed bc is empty LEGACY had... 
// export const approvalToolkit: Partial<Toolkit> = {};

export const toolkit = {
  ...nativeToolkit,
  ...{},
  ...customToolkit,
} as Toolkit;
