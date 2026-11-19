/**
 * Minimal types for the parts of the WordPress editor packages this block
 * uses. They are provided at runtime by WordPress (as `wp.*` globals), so
 * the packages themselves are not installed.
 */

declare module '@wordpress/element' {
  export {
    createElement,
    Fragment,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
  } from 'react';
}

declare module '@wordpress/i18n' {
  export function __(text: string, domain?: string): string;
  export function _n(single: string, plural: string, count: number, domain?: string): string;
  export function sprintf(format: string, ...args: (string | number)[]): string;
}

declare module '@wordpress/url' {
  export function addQueryArgs(url: string, args: Record<string, string | number>): string;
}

declare module '@wordpress/api-fetch' {
  interface ApiFetchOptions {
    path: string;
    method?: string;
    data?: unknown;
  }
  export default function apiFetch<T>(options: ApiFetchOptions): Promise<T>;
}

declare module '@wordpress/blocks' {
  import type { ComponentType, ReactNode } from 'react';

  export interface BlockEditProps<T> {
    attributes: T;
    setAttributes: (attributes: Partial<T>) => void;
    isSelected: boolean;
    clientId: string;
  }

  export interface BlockInstance {
    name: string;
    attributes: Record<string, unknown>;
  }

  export interface ShortcodeAttributes {
    named: Record<string, string | undefined>;
    numeric: string[];
  }

  export type BlockTransform =
    | {
        type: 'raw';
        priority?: number;
        isMatch: (node: Node) => boolean;
        transform: (node: Node) => BlockInstance;
      }
    | {
        type: 'shortcode';
        tag: string;
        transform: (attributes: ShortcodeAttributes) => BlockInstance;
      };

  export interface BlockSettings<T> {
    icon?: ReactNode;
    edit: ComponentType<BlockEditProps<T>>;
    save: () => null;
    transforms?: { from?: BlockTransform[] };
  }

  export function registerBlockType<T>(name: string, settings: BlockSettings<T>): unknown;
  export function createBlock(name: string, attributes?: Record<string, unknown>): BlockInstance;
}

declare module '@wordpress/block-editor' {
  import type { ComponentType, ReactNode } from 'react';

  export function useBlockProps(props?: Record<string, unknown>): Record<string, unknown>;
  export const InspectorControls: ComponentType<{ children?: ReactNode; group?: string }>;
  export const BlockControls: ComponentType<{ children?: ReactNode; group?: string }>;
}

declare module '@wordpress/components' {
  import type { ComponentType, ReactNode } from 'react';

  interface Option {
    label: string;
    value: string;
    disabled?: boolean;
  }

  export const Placeholder: ComponentType<{
    icon?: ReactNode;
    label?: string;
    instructions?: string;
    className?: string;
    children?: ReactNode;
  }>;
  export const Button: ComponentType<{
    variant?: 'primary' | 'secondary' | 'tertiary' | 'link';
    onClick?: () => void;
    disabled?: boolean;
    isBusy?: boolean;
    type?: 'button' | 'submit';
    href?: string;
    children?: ReactNode;
    __next40pxDefaultSize?: boolean;
  }>;
  export const TextControl: ComponentType<{
    label: string;
    value: string;
    onChange: (value: string) => void;
    help?: ReactNode;
    placeholder?: string;
    type?: string;
    hideLabelFromVision?: boolean;
    __next40pxDefaultSize?: boolean;
    __nextHasNoMarginBottom?: boolean;
  }>;
  export const SelectControl: ComponentType<{
    label: string;
    value: string;
    options: Option[];
    onChange: (value: string) => void;
    help?: ReactNode;
    __next40pxDefaultSize?: boolean;
    __nextHasNoMarginBottom?: boolean;
  }>;
  export const ToggleControl: ComponentType<{
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
    help?: ReactNode;
    __nextHasNoMarginBottom?: boolean;
  }>;
  export const FormTokenField: ComponentType<{
    label: string;
    value: string[];
    suggestions?: string[];
    onChange: (tokens: (string | { value: string })[]) => void;
    __experimentalExpandOnFocus?: boolean;
    __next40pxDefaultSize?: boolean;
    __nextHasNoMarginBottom?: boolean;
  }>;
  export const PanelBody: ComponentType<{
    title: string;
    initialOpen?: boolean;
    children?: ReactNode;
  }>;
  export const Notice: ComponentType<{
    status?: 'error' | 'warning' | 'info' | 'success';
    isDismissible?: boolean;
    children?: ReactNode;
  }>;
  export const ExternalLink: ComponentType<{ href: string; children?: ReactNode }>;
  export const Spinner: ComponentType;
  export const ToolbarGroup: ComponentType<{ children?: ReactNode }>;
  export const ToolbarButton: ComponentType<{ onClick?: () => void; children?: ReactNode }>;
}
