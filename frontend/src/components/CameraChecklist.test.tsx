import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CameraChecklist } from './CameraChecklist';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) =>
      (({
        'timeline.searchCameras': 'Search…',
        'timeline.selectAll': 'Select all',
        'timeline.selectNone': 'Clear all',
        'timeline.noCamerasMatch': 'No cameras match',
      }) as Record<string, string>)[key] ?? key,
    language: 'en',
  }),
}));

function setup(over: Partial<React.ComponentProps<typeof CameraChecklist>> = {}) {
  const props = {
    cameras: ['cam-front', 'cam-back', 'cam-yard'],
    isChecked: (c: string) => c !== 'cam-back',
    onToggle: vi.fn(),
    onSelectAll: vi.fn(),
    onSelectNone: vi.fn(),
    testIdPrefix: 'cc',
    ...over,
  };
  render(<CameraChecklist {...props} />);
  return props;
}

describe('CameraChecklist', () => {
  it('renders a checkbox per camera reflecting isChecked', () => {
    setup();
    expect(screen.getByRole('checkbox', { name: 'cam-front' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'cam-back' })).not.toBeChecked();
  });

  it('calls onToggle with the camera name when a box is clicked', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'cam-front' }));
    expect(props.onToggle).toHaveBeenCalledWith('cam-front');
  });

  it('search filters the visible cameras (case-insensitive)', () => {
    setup();
    fireEvent.change(screen.getByTestId('cc-search'), { target: { value: 'YARD' } });
    expect(screen.getByRole('checkbox', { name: 'cam-yard' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'cam-front' })).not.toBeInTheDocument();
  });

  it('shows the empty state when nothing matches', () => {
    setup();
    fireEvent.change(screen.getByTestId('cc-search'), { target: { value: 'zzz' } });
    expect(screen.getByText('No cameras match')).toBeInTheDocument();
  });

  it('Select all / Clear all call their handlers', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('cc-all'));
    fireEvent.click(screen.getByTestId('cc-none'));
    expect(props.onSelectAll).toHaveBeenCalledTimes(1);
    expect(props.onSelectNone).toHaveBeenCalledTimes(1);
  });

  it('renders a color dot per row only when colorMap is provided', () => {
    const { container } = render(
      <CameraChecklist
        cameras={['a']}
        isChecked={() => true}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onSelectNone={() => {}}
        testIdPrefix="cc"
        colorMap={new Map([['a', '#f00']])}
      />,
    );
    expect(container.querySelector('.timeline-camera-dot')).not.toBeNull();
  });
});
