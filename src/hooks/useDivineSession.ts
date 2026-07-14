// ABOUTME: Hook to read the divine-login session from DivineSessionContext.
import { useContext } from 'react';
import { DivineSessionContext, type DivineSessionValue } from '@/contexts/DivineSessionContext';

export function useDivineSession(): DivineSessionValue {
  return useContext(DivineSessionContext);
}
