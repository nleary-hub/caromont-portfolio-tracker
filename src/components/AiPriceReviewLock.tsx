"use client";

import { createContext, useContext } from "react";

/** True while the price-refresh review is open: the model table below it is locked until Cancel or Confirm (step 3c). */
export const PriceReviewLock = createContext(false);

export const usePriceReviewLock = () => useContext(PriceReviewLock);
