import type { Toolkit } from '@assistant-ui/react';
import { nativeToolkit } from './native-tools';
import { approvalToolkit } from './approval-tools';
import { customToolkit } from './customToolkit/customToolkit';

export const toolkit = {
  ...nativeToolkit,
  ...approvalToolkit,
  ...customToolkit,
} as Toolkit;
