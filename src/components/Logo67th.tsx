"use client";

import React, { useEffect, useRef, useState } from "react";

interface Props {
  /** fires whenever the user types "67th" anywhere in the page */
  triggered: boolean;
  onAnimationEnd: () => void;
}

const LETTERS = ["6", "7", "t"];

export default function Logo67th({ triggered, onAnimationEnd }: Props) {
  const [animating, setAnimating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!triggered) return;
    setAnimating(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setAnimating(false);
      onAnimationEnd();
    }, 900);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [triggered, onAnimationEnd]);

  return (
    <span className="logo-67th" aria-label="67t">
      {LETTERS.map((char, i) => (
        <span
          key={i}
          className={`logo-char logo-char-${i}${animating ? " logo-char-animate" : ""}`}
          style={{ animationDelay: animating ? `${i * 80}ms` : "0ms" }}
        >
          {char}
        </span>
      ))}
    </span>
  );
}
