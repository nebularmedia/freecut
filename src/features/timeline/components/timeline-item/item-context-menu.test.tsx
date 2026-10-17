import type { ComponentProps, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { fireEvent, render, screen } from '@testing-library/react'
import { useSelectionStore } from '@/shared/state/selection'
import { ItemContextMenu } from './item-context-menu'

const { mockGetSceneVerificationModelOptions } = vi.hoisted(() => ({
  mockGetSceneVerificationModelOptions: vi.fn(() => [
    { value: 'gemma', label: 'Gemma Turbo' },
    { value: 'lfm', label: 'Liquid Vision' },
  ]),
}))

const { mockContextMenuProps } = vi.hoisted(() => ({
  mockContextMenuProps: vi.fn(),
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children, ...props }: { children: ReactNode; modal?: boolean }) => {
    mockContextMenuProps(props)
    return <div>{children}</div>
  },
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => null,
  ContextMenuShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ContextMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/features/timeline/deps/analysis', () => ({
  getSceneVerificationModelOptions: mockGetSceneVerificationModelOptions,
}))

vi.mock('@/features/timeline/deps/settings', () => ({
  useResolvedHotkeys: () => ({}),
}))

vi.mock('@/config/hotkeys', () => ({
  formatHotkeyBinding: () => '',
}))

function renderContextMenu(overrides: Partial<ComponentProps<typeof ItemContextMenu>> = {}) {
  const onDetectScenes = vi.fn()

  render(
    <ItemContextMenu
      trackLocked={false}
      joinActions={{
        canJoinSelected: false,
        hasJoinableLeft: false,
        hasJoinableRight: false,
        closerEdge: null,
        onJoinSelected: () => {},
        onJoinLeft: () => {},
        onJoinRight: () => {},
      }}
      destructiveActions={{
        isSelected: true,
        onRippleDelete: () => {},
        onDelete: () => {},
      }}
      sceneDetectionActions={{
        canDetectScenes: true,
        isDetectingScenes: false,
        onDetectScenes,
      }}
      {...overrides}
    >
      <div>Clip</div>
    </ItemContextMenu>,
  )

  fireEvent.contextMenu(screen.getByText('Clip'))

  return { onDetectScenes }
}

describe('ItemContextMenu scene detection', () => {
  beforeEach(() => {
    mockGetSceneVerificationModelOptions.mockClear()
    mockContextMenuProps.mockClear()
    useSelectionStore.setState({
      selectedItemIds: [],
      selectedMarkerId: null,
      selectedTransitionId: null,
      selectedTrackId: null,
      selectedTrackIds: [],
      activeTrackId: null,
      selectionType: null,
    })
  })

  it('keeps the menu non-modal so dialog handoffs cannot strand pointer blocking', () => {
    renderContextMenu()

    expect(mockContextMenuProps).toHaveBeenLastCalledWith({ modal: false })
  })

  it('renders scene verification submenu labels from shared options', () => {
    renderContextMenu()

    expect(mockGetSceneVerificationModelOptions).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Detect Scenes & Split')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fast (Histogram)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AI (Gemma Turbo)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AI (Liquid Vision)' })).toBeInTheDocument()
  })

  it('dispatches the selected verification model when a scene detection option is clicked', () => {
    const { onDetectScenes } = renderContextMenu()

    fireEvent.click(screen.getByRole('button', { name: 'AI (Liquid Vision)' }))

    expect(onDetectScenes).toHaveBeenCalledWith('adaptive', 'lfm')
  })
})

describe('ItemContextMenu captions', () => {
  it('shows a single "Generate Captions" item when no transcript exists', () => {
    const onOpenCaptionDialog = vi.fn()

    renderContextMenu({
      captionActions: {
        canManageCaptions: true,
        hasCaptions: false,
        onOpenCaptionDialog,
      },
    })

    const item = screen.getByRole('button', { name: 'Generate Captions' })
    expect(item).toBeInTheDocument()
    expect(screen.queryByText('Captions')).not.toBeInTheDocument()
    fireEvent.click(item)
    expect(onOpenCaptionDialog).toHaveBeenCalledTimes(1)
  })

  it('shows a single "Generate Captions" item when captions are disabled', () => {
    const onOpenCaptionDialog = vi.fn()

    renderContextMenu({
      captionActions: {
        canManageCaptions: true,
        hasCaptions: false,
        onOpenCaptionDialog,
      },
    })

    const item = screen.getByRole('button', { name: 'Generate Captions' })
    expect(item).toBeInTheDocument()
    expect(screen.queryByText('Captions')).not.toBeInTheDocument()

    fireEvent.click(item)
    expect(onOpenCaptionDialog).toHaveBeenCalledTimes(1)
  })

  it('labels the generate item "Regenerate Captions" when the clip already has captions', () => {
    renderContextMenu({
      captionActions: {
        canManageCaptions: true,
        hasCaptions: true,
        onOpenCaptionDialog: vi.fn(),
      },
    })

    expect(screen.getByRole('button', { name: 'Regenerate Captions' })).toBeInTheDocument()
  })

  it('does not show transcript visibility controls when the clip already has captions', () => {
    renderContextMenu({
      captionActions: {
        canManageCaptions: true,
        hasCaptions: true,
        onOpenCaptionDialog: vi.fn(),
      },
    })

    expect(
      screen.queryByRole('button', { name: 'Hide Transcript Captions' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Show Transcript Captions' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Insert Existing Captions' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate Captions' })).toBeInTheDocument()
  })
})

describe('ItemContextMenu stabilization', () => {
  beforeEach(() => {
    useSelectionStore.setState({
      selectedItemIds: [],
      selectedMarkerId: null,
      selectedTransitionId: null,
      selectedTrackId: null,
      selectedTrackIds: [],
      activeTrackId: null,
      selectionType: null,
    })
  })

  it('offers a strength per crop budget and reports what each one costs', () => {
    const onStabilize = vi.fn()
    renderContextMenu({
      stabilizeActions: { canStabilize: true, isStabilizing: false, onStabilize },
    })

    // The label has to name the price, because the crop is the whole trade.
    expect(screen.getByRole('button', { name: 'Gentle — 5% crop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Standard — 10% crop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Strong — 15% crop' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Strong — 15% crop' }))
    expect(onStabilize).toHaveBeenCalledWith('strong')
  })

  it('replaces the strengths with a disabled notice while a render is running', () => {
    const onStabilize = vi.fn()
    renderContextMenu({
      stabilizeActions: { canStabilize: true, isStabilizing: true, onStabilize },
    })

    expect(screen.getByRole('button', { name: 'Stabilizing…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Standard — 10% crop' })).not.toBeInTheDocument()
  })

  it('stays out of the menu for clips that cannot be stabilized', () => {
    renderContextMenu({
      stabilizeActions: { canStabilize: false, isStabilizing: false, onStabilize: vi.fn() },
    })

    expect(screen.queryByRole('button', { name: 'Stabilize Clip' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Standard — 10% crop' })).not.toBeInTheDocument()
  })
})
