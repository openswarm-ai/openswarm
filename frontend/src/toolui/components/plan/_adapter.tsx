/**
 * Adapter: UI and utility re-exports for copy-standalone portability.
 *
 * When copying this component to another project, update these imports
 * to match your project's paths:
 *
 *   cn          → Your Tailwind merge utility (e.g., "@toolui/lib/utils", "~/lib/cn")
 *   Accordion   → shadcn/ui Accordion
 *   Card        → shadcn/ui Card
 *   Collapsible → shadcn/ui Collapsible
 */

export { cn } from "@toolui/lib/utils";
export {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@toolui/ui/accordion";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@toolui/ui/card";
export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@toolui/ui/collapsible";
