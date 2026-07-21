/**
 * Adapter: UI and utility re-exports for copy-standalone portability.
 *
 * When copying this component to another project, update these imports
 * to match your project's paths:
 *
 *   cn    → Your Tailwind merge utility (e.g., "@toolui/lib/utils", "~/lib/cn")
 *   Chart → shadcn/ui Chart (recharts wrapper)
 *   Card  → shadcn/ui Card
 */

export { cn } from "@toolui/lib/utils";
export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@toolui/ui/chart";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@toolui/ui/card";
