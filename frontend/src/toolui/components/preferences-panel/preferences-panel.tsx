"use client";

import { useCallback, useMemo } from "react";
import type {
  PreferencesPanelProps,
  PreferencesPanelReceiptProps,
  PreferencesValue,
  PreferenceItem,
  PreferenceSection,
} from "./schema";
import { ActionButtons } from "../shared/action-buttons";
import { normalizeActionsConfig } from "../shared/actions-config";
import { type Action } from "../shared/schema";
import { useControllableState } from "../shared/use-controllable-state";
import { useSignatureReset } from "../shared/use-signature-reset";

import {
  cn,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Label,
} from "./_adapter";
import { Check, AlertCircle } from "lucide-react";
import { createPreferencesSectionSignature } from "./signature";

function getInitialValue(item: PreferenceItem): string | boolean {
  switch (item.type) {
    case "switch":
      return item.defaultChecked ?? false;
    case "toggle":
      return item.defaultValue ?? item.options?.[0]?.value ?? "";
    case "select":
      return item.defaultSelected ?? item.selectOptions?.[0]?.value ?? "";
  }
}

function formatDisplayValue(
  item: PreferenceItem,
  value: string | boolean,
): string {
  if (item.type === "switch") {
    return typeof value === "boolean" && value ? "On" : "Off";
  }

  const stringValue = typeof value === "string" ? value : "";
  const options = item.type === "toggle" ? item.options : item.selectOptions;
  const option = options?.find((opt) => opt.value === stringValue);

  return option?.label ?? stringValue;
}

function computeInitialValues(sections: PreferenceSection[]): PreferencesValue {
  return sections.reduce<PreferencesValue>((acc, section) => {
    section.items.forEach((item) => {
      acc[item.id] = getInitialValue(item);
    });
    return acc;
  }, {});
}

interface PreferenceControlProps {
  item: PreferenceItem;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
  disabled?: boolean;
}

function SwitchControl({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Switch
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
    />
  );
}

function ToggleControl({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v)}
      disabled={disabled}
      aria-label={label}
      className="gap-1"
    >
      {options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          aria-label={opt.label}
          className="!rounded-full px-3 py-1.5 text-sm"
        >
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SelectControl({
  id,
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  id: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-[180px]" aria-label={label}>
        <SelectValue placeholder="Select..." />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PreferenceControl({
  item,
  value,
  onChange,
  disabled,
}: PreferenceControlProps) {
  const id = `preference-${item.id}`;

  if (item.type === "switch") {
    return (
      <SwitchControl
        id={id}
        checked={typeof value === "boolean" ? value : false}
        onChange={onChange}
        disabled={disabled}
        label={item.label}
      />
    );
  }

  const stringValue = typeof value === "string" ? value : "";

  if (item.type === "toggle" && item.options) {
    return (
      <ToggleControl
        value={stringValue}
        options={item.options}
        onChange={onChange}
        disabled={disabled}
        label={item.label}
      />
    );
  }

  if (item.type === "select" && item.selectOptions) {
    return (
      <SelectControl
        id={id}
        value={stringValue}
        options={item.selectOptions}
        onChange={onChange}
        disabled={disabled}
        label={item.label}
      />
    );
  }

  return null;
}

interface PreferenceItemRowProps {
  item: PreferenceItem;
  value: string | boolean;
  onChange?: (value: string | boolean) => void;
  disabled?: boolean;
  isReceipt?: boolean;
  error?: string;
  showSuccessIndicators?: boolean;
  isFirstInSectionWithoutHeading?: boolean;
}

function ItemLabel({
  item,
  error,
  isReceipt,
}: {
  item: PreferenceItem;
  error?: string;
  isReceipt: boolean;
}) {
  const htmlFor = `preference-${item.id}`;

  if (isReceipt) {
    return (
      <>
        <span className="text-sm leading-6 font-medium text-pretty">
          {item.label}
        </span>
        {error ? (
          <span className="text-destructive text-sm font-normal text-pretty">
            {error}
          </span>
        ) : item.description ? (
          <span className="text-muted-foreground text-sm font-normal text-pretty">
            {item.description}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Label htmlFor={htmlFor} className="leading-6 font-medium text-pretty">
        {item.label}
      </Label>
      {item.description && (
        <p className="text-muted-foreground text-sm font-normal text-pretty">
          {item.description}
        </p>
      )}
    </>
  );
}

function ItemValue({
  item,
  value,
  error,
  showSuccessIndicators,
}: {
  item: PreferenceItem;
  value: string | boolean;
  error?: string;
  showSuccessIndicators: boolean;
}) {
  const displayValue = formatDisplayValue(item, value);

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-muted-foreground text-sm font-medium">
        {displayValue}
      </span>
      {error ? (
        <AlertCircle className="text-destructive size-3.5" />
      ) : showSuccessIndicators ? (
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-500" />
      ) : null}
    </div>
  );
}

function PreferenceItemRow({
  item,
  value,
  onChange,
  disabled,
  isReceipt = false,
  error,
  showSuccessIndicators = false,
  isFirstInSectionWithoutHeading = false,
}: PreferenceItemRowProps) {
  const shouldStack = item.type !== "switch" && !isReceipt;

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4",
        isFirstInSectionWithoutHeading ? "pt-0 pb-3" : "py-3",
        shouldStack &&
          "flex-col gap-3 @sm/preferences-panel:flex-row @sm/preferences-panel:gap-4",
      )}
    >
      <div className="flex flex-col gap-1">
        <ItemLabel item={item} error={error} isReceipt={isReceipt} />
      </div>

      {isReceipt ? (
        <ItemValue
          item={item}
          value={value}
          error={error}
          showSuccessIndicators={showSuccessIndicators}
        />
      ) : (
        <div className="flex shrink-0">
          <PreferenceControl
            item={item}
            value={value}
            onChange={onChange!}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

interface ItemListProps {
  items: PreferenceItem[];
  values: PreferencesValue;
  onChangeValue?: (itemId: string, value: string | boolean) => void;
  disabled?: boolean;
  isReceipt?: boolean;
  errors?: Record<string, string>;
  showSuccessIndicators?: boolean;
  hasHeading?: boolean;
  hasTitle?: boolean;
}

function ItemList({
  items,
  values,
  onChangeValue,
  disabled,
  isReceipt,
  errors,
  showSuccessIndicators,
  hasHeading = false,
  hasTitle = false,
}: ItemListProps) {
  const shouldRemoveFirstPadding = !hasHeading && hasTitle;

  return (
    <div className="flex flex-col">
      {items.map((item, index) => {
        const isFirst = index === 0;
        const itemValue = values[item.id] ?? getInitialValue(item);
        const handleChange = onChangeValue
          ? (v: string | boolean) => onChangeValue(item.id, v)
          : undefined;

        return (
          <div key={item.id}>
            {!isFirst && <Separator className="my-1" />}
            <PreferenceItemRow
              item={item}
              value={itemValue}
              onChange={handleChange}
              disabled={disabled}
              isReceipt={isReceipt}
              error={errors?.[item.id]}
              showSuccessIndicators={showSuccessIndicators}
              isFirstInSectionWithoutHeading={
                isFirst && shouldRemoveFirstPadding
              }
            />
          </div>
        );
      })}
    </div>
  );
}

interface PreferencesSectionProps {
  section: PreferenceSection;
  values: PreferencesValue;
  onChangeValue?: (itemId: string, value: string | boolean) => void;
  disabled?: boolean;
  isReceipt?: boolean;
  errors?: Record<string, string>;
  hasTitle?: boolean;
}

function PreferencesSection({
  section,
  values,
  onChangeValue,
  disabled,
  isReceipt = false,
  errors,
  hasTitle = false,
}: PreferencesSectionProps) {
  const hasErrors = !!(errors && Object.keys(errors).length > 0);

  const content = (
    <ItemList
      items={section.items}
      values={values}
      onChangeValue={onChangeValue}
      disabled={disabled}
      isReceipt={isReceipt}
      errors={errors}
      showSuccessIndicators={hasErrors}
      hasHeading={!!section.heading}
      hasTitle={hasTitle}
    />
  );

  if (section.heading) {
    return (
      <fieldset className="flex flex-col">
        <legend className="text-muted-foreground pb-1 text-xs tracking-widest uppercase">
          {section.heading}
        </legend>
        {content}
      </fieldset>
    );
  }

  return content;
}

interface ReceiptHeaderProps {
  title: string;
  hasErrors: boolean;
}

function ReceiptHeader({ title, hasErrors }: ReceiptHeaderProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <h2 className="text-base leading-none font-semibold">{title}</h2>
        {hasErrors === true ? (
          <span className="text-destructive flex items-center gap-1.5 text-xs font-medium">
            <AlertCircle className="size-3.5" />
            Error
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-500">
            <Check className="size-3.5" />
            Saved
          </span>
        )}
      </div>
      <Separator />
    </>
  );
}

export function PreferencesPanelReceipt({
  id,
  title,
  sections,
  choice,
  error,
  className,
}: PreferencesPanelReceiptProps) {
  const hasErrors = error && Object.keys(error).length > 0;

  return (
    <article
      data-slot="preferences-panel"
      data-tool-ui-id={id}
      data-receipt="true"
      role="status"
      aria-label={
        hasErrors ? "Preferences with errors" : "Confirmed preferences"
      }
      className={cn(
        "@container/preferences-panel flex w-full max-w-md min-w-80 flex-col",
        className,
      )}
    >
      <div className="bg-card/60 flex w-full flex-col overflow-hidden rounded-2xl border opacity-95 shadow-xs">
        {title && <ReceiptHeader title={title} hasErrors={!!hasErrors} />}
        <div
          className={cn("flex flex-col gap-4 px-5", title ? "py-6" : "py-2")}
        >
          {sections.map((section, index) => (
            <div key={index}>
              <PreferencesSection
                section={section}
                values={choice}
                errors={error}
                isReceipt={true}
                hasTitle={!!title}
              />
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function PreferencesPanelRoot({
  id,
  title,
  sections,
  value: controlledValue,
  onChange,
  actions,
  onAction,
  onBeforeAction,
  className,
}: PreferencesPanelProps) {
  const initialValues = useMemo(
    () => computeInitialValues(sections),
    [sections],
  );
  const sectionsSignature = useMemo(
    () => createPreferencesSectionSignature(sections),
    [sections],
  );
  const {
    value: currentValue,
    isControlled,
    setValue,
    setUncontrolledValue,
  } = useControllableState<PreferencesValue>({
    value: controlledValue,
    defaultValue: initialValues,
    onChange,
  });

  useSignatureReset(sectionsSignature, () => {
    if (!isControlled) {
      setUncontrolledValue(initialValues);
    }
  });

  const updateValue = useCallback(
    (itemId: string, newValue: string | boolean) => {
      setValue((prev) => ({ ...prev, [itemId]: newValue }));
    },
    [setValue],
  );

  const isDirty = useMemo(() => {
    return Object.keys(currentValue).some(
      (key) => currentValue[key] !== initialValues[key],
    );
  }, [currentValue, initialValues]);

  const handleCancel = useCallback((): PreferencesValue => {
    setValue(initialValues);
    return initialValues;
  }, [initialValues, setValue]);

  const handleAction = useCallback(
    async (actionId: string) => {
      let nextValue = currentValue;

      if (actionId === "cancel") {
        nextValue = handleCancel();
      }

      await onAction?.(actionId, nextValue);
    },
    [currentValue, handleCancel, onAction],
  );

  const normalizedActions = useMemo(() => {
    const normalized = normalizeActionsConfig(actions);
    if (normalized) {
      return {
        ...normalized,
        align: normalized.align ?? ("right" as const),
      };
    }

    const defaultActions: Action[] = [
      { id: "cancel", label: "Cancel", variant: "ghost" },
      { id: "save", label: "Save Changes", variant: "default" },
    ];

    return {
      items: defaultActions,
      align: "right" as const,
    };
  }, [actions]);

  const actionsWithState = useMemo((): Action[] => {
    return normalizedActions.items.map((action) => {
      const isSaveAction = action.id === "save";
      const baseDisabled = "disabled" in action ? action.disabled : false;
      const shouldDisable = baseDisabled || (isSaveAction && !isDirty);

      return {
        ...action,
        disabled: shouldDisable,
      };
    });
  }, [normalizedActions.items, isDirty]);

  return (
    <article
      data-slot="preferences-panel"
      data-tool-ui-id={id}
      role="form"
      className={cn(
        "text-foreground @container/preferences-panel flex w-full max-w-md min-w-80 flex-col gap-3",
        className,
      )}
    >
      <div className="bg-card flex w-full flex-col overflow-hidden rounded-2xl border shadow-xs">
        {title && (
          <>
            <div className="px-5 py-4">
              <h2 className="text-base leading-none font-semibold">{title}</h2>
            </div>
            <Separator />
          </>
        )}
        <div
          className={cn("flex flex-col gap-4 px-5", title ? "py-6" : "py-2")}
        >
          {sections.map((section, sectionIndex) => (
            <div key={sectionIndex}>
              <PreferencesSection
                section={section}
                values={currentValue}
                onChangeValue={updateValue}
                isReceipt={false}
                hasTitle={!!title}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="@container/actions">
        <ActionButtons
          actions={actionsWithState}
          align={normalizedActions.align}
          confirmTimeout={normalizedActions.confirmTimeout}
          onAction={handleAction}
          onBeforeAction={
            onBeforeAction
              ? (actionId) => onBeforeAction(actionId, currentValue)
              : undefined
          }
        />
      </div>
    </article>
  );
}

type PreferencesPanelComponent = typeof PreferencesPanelRoot & {
  Receipt: typeof PreferencesPanelReceipt;
};

export const PreferencesPanel = Object.assign(PreferencesPanelRoot, {
  Receipt: PreferencesPanelReceipt,
}) as PreferencesPanelComponent;
