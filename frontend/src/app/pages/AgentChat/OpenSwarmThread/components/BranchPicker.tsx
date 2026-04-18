import { type FC } from 'react';
import { BranchPickerPrimitive } from '@assistant-ui/react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { TooltipIconButton } from './TooltipIconButton';
import { cn } from '@/lib/utils';

export const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => (
  <BranchPickerPrimitive.Root
    hideWhenSingleBranch
    className={cn(
      'aui-branch-picker-root mr-2 -ml-2 inline-flex items-center text-muted-foreground text-xs',
      className,
    )}
    {...rest}
  >
    <BranchPickerPrimitive.Previous asChild>
      <TooltipIconButton tooltip="Previous">
        <ChevronLeftIcon />
      </TooltipIconButton>
    </BranchPickerPrimitive.Previous>
    <span className="aui-branch-picker-state font-medium">
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next asChild>
      <TooltipIconButton tooltip="Next">
        <ChevronRightIcon />
      </TooltipIconButton>
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);
