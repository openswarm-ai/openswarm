"use client";

import { useEffect, useRef } from "react";

export function useSignatureReset(
  signature: string,
  onSignatureChange: () => void,
) {
  const previousSignature = useRef(signature);

  useEffect(() => {
    if (previousSignature.current === signature) return;
    previousSignature.current = signature;
    onSignatureChange();
  }, [signature, onSignatureChange]);
}
