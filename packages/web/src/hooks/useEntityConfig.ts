import { useState, useCallback } from "react";
import { colorOptions } from "./useAccountColors";

const ORGS_KEY = "missive_managed_organizations";
const PROJECTS_KEY = "missive_managed_projects";

export interface ConfigItem {
  name: string;
  colorIndex: number;
}

function loadItems(key: string): ConfigItem[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveItems(key: string, items: ConfigItem[]) {
  localStorage.setItem(key, JSON.stringify(items));
}

export function useEntityConfig(storageKey: string) {
  const [items, setItems] = useState<ConfigItem[]>(() => loadItems(storageKey));

  const addItem = useCallback(
    (name: string) => {
      setItems((prev) => {
        if (prev.some((i) => i.name.toLowerCase() === name.toLowerCase())) return prev;
        const next = [...prev, { name, colorIndex: prev.length % colorOptions.length }];
        saveItems(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const removeItem = useCallback(
    (name: string) => {
      setItems((prev) => {
        const next = prev.filter((i) => i.name !== name);
        saveItems(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const renameItem = useCallback(
    (oldName: string, newName: string) => {
      setItems((prev) => {
        const next = prev.map((i) =>
          i.name === oldName ? { ...i, name: newName } : i
        );
        saveItems(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const setColor = useCallback(
    (name: string, colorIndex: number) => {
      setItems((prev) => {
        const next = prev.map((i) =>
          i.name === name ? { ...i, colorIndex } : i
        );
        saveItems(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  return { items, addItem, removeItem, renameItem, setColor };
}
