export type WorldSizeName = 'small' | 'normal' | 'large';

export interface WorldSize {
  readonly name: WorldSizeName;
  readonly label: string;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}

export const WORLD_HEIGHT = 64;

export const WORLD_SIZES: Record<WorldSizeName, WorldSize> = {
  small: { name: 'small', label: 'Small (128×128)', sx: 128, sy: WORLD_HEIGHT, sz: 128 },
  normal: { name: 'normal', label: 'Normal (256×256)', sx: 256, sy: WORLD_HEIGHT, sz: 256 },
  large: { name: 'large', label: 'Large (512×512)', sx: 512, sy: WORLD_HEIGHT, sz: 512 },
};

export function isWorldSizeName(value: string): value is WorldSizeName {
  return value === 'small' || value === 'normal' || value === 'large';
}
