"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export type UseControllableStateOptions<T> = {
  value?: T;
  defaultValue: T;
  onChange?: (next: T) => void;
};

export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: UseControllableStateOptions<T>) {
  const [uncontrolled, setUncontrolled] = useState<T>(defaultValue);
  const isControlled = value !== undefined;

  const currentValue = useMemo(
    () => (isControlled ? (value as T) : uncontrolled),
    [isControlled, value, uncontrolled],
  );
  const currentValueRef = useRef(currentValue);
  currentValueRef.current = currentValue;

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function"
          ? (next as (prev: T) => T)(currentValueRef.current)
          : next;

      currentValueRef.current = resolved;
      if (!isControlled) {
        setUncontrolled(resolved);
      }

      onChange?.(resolved);
      return resolved;
    },
    [isControlled, onChange],
  );

  const setUncontrolledValue = useCallback((next: T) => {
    setUncontrolled(next);
  }, []);

  return {
    value: currentValue,
    isControlled,
    setValue,
    setUncontrolledValue,
  };
}
