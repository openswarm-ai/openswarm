/**
 * Adapter: UI and utility re-exports for copy-standalone portability.
 *
 * When copying this component to another project, update these imports
 * to match your project's paths:
 *
 *   cn           → Your Tailwind merge utility (e.g., "@toolui/lib/utils", "~/lib/cn")
 *   Button       → shadcn/ui Button
 *   DropdownMenu → shadcn/ui DropdownMenu
 *   Accordion    → shadcn/ui Accordion
 *   Tooltip      → shadcn/ui Tooltip
 *   Badge        → shadcn/ui Badge
 *   Table        → shadcn/ui Table
 */

export { cn } from "@toolui/lib/utils";
export { Button } from "@toolui/ui/button";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@toolui/ui/dropdown-menu";
export {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@toolui/ui/accordion";
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@toolui/ui/tooltip";
export { Badge } from "@toolui/ui/badge";
export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@toolui/ui/table";
