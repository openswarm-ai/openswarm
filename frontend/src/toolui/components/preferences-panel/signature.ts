import type { PreferenceSection } from "./schema";

export function createPreferencesSectionSignature(
  sections: PreferenceSection[],
): string {
  return JSON.stringify(
    sections.map((section) => ({
      heading: section.heading ?? "",
      items: section.items.map((item) => {
        if (item.type === "switch") {
          return {
            id: item.id,
            type: item.type,
            defaultChecked: item.defaultChecked ?? false,
          };
        }

        if (item.type === "toggle") {
          return {
            id: item.id,
            type: item.type,
            defaultValue: item.defaultValue ?? item.options[0]?.value ?? "",
            options: item.options.map((option) => option.value),
          };
        }

        return {
          id: item.id,
          type: item.type,
          defaultSelected:
            item.defaultSelected ?? item.selectOptions[0]?.value ?? "",
          options: item.selectOptions.map((option) => option.value),
        };
      }),
    })),
  );
}
