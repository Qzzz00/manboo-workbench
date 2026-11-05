import { useEffect, useState } from 'react';
import { fetchCrisisResources, type CrisisResource } from '../lib/journeyApi.ts';

export function useCrisisResources() {
  const [resources, setResources] = useState<CrisisResource[]>([]);

  useEffect(() => {
    let alive = true;
    fetchCrisisResources()
      .then((items) => {
        if (alive) setResources(items);
      })
      .catch((error) => {
        console.warn('[crisis-resources] load failed:', error);
      });
    return () => {
      alive = false;
    };
  }, []);

  return resources;
}
