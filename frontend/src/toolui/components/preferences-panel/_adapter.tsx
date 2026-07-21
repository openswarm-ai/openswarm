/**
 * Adapter: UI and utility re-exports for copy-standalone portability.
 *
 * When copying this component to another project, update these imports
 * to match your project's paths:
 *
 *   cn           → Your Tailwind merge utility (e.g., "@toolui/lib/utils", "~/lib/cn")
 *   Button       → shadcn/ui Button
 *   Switch       → shadcn/ui Switch
 *   ToggleGroup  → shadcn/ui ToggleGroup
 *   Select       → shadcn/ui Select
 *   Separator    → shadcn/ui Separator
 *   Label        → shadcn/ui Label
 */

export { cn } from "@toolui/lib/utils";
export { Button } from "@toolui/ui/button";
export { Switch } from "@toolui/ui/switch";
export { ToggleGroup, ToggleGroupItem } from "@toolui/ui/toggle-group";
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@toolui/ui/select";
export { Separator } from "@toolui/ui/separator";
export { Label } from "@toolui/ui/label";
