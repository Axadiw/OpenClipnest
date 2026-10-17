import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterBar } from './FilterBar';

vi.mock('../i18n', () => ({
  registerTranslations: vi.fn(),
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'filter.title': 'Filters',
        'filter.cameras': 'Cameras',
        'filter.apply': 'Apply',
        'filter.clear': 'Clear',
        'filter.modeLabel': 'Time-filter mode',
        'filter.modeDaily': 'Time of day',
        'filter.modeRange': 'Time range',
        'filter.rangeFrom': 'rangeFrom',
        'filter.rangeTo': 'rangeTo',
        'filter.dateFrom': 'dateFrom',
        'filter.dateTo': 'dateTo',
        'filter.timeFrom': 'From hour',
        'filter.timeTo': 'To hour',
        'timeline.pickDate': 'Pick a date',
        'timeline.searchCameras': 'Search…',
        'timeline.selectAll': 'Select all',
        'timeline.selectNone': 'Clear all',
        'timeline.noCamerasMatch': 'No cameras match',
      };
      return map[key] ?? key;
    },
    language: 'en',
  }),
}));

// Stub the heat-map calendar so these unit tests don't hit the network
// or depend on `api.getEventCalendar`. The mock surfaces a single button
// keyed by date string — clicking it simulates picking that day.
vi.mock('./TimelineDatePicker', () => ({
  TimelineDatePicker: ({ onSelect }: { onSelect: (d: Date) => void }) => (
    <div data-testid="mock-timeline-datepicker">
      <button
        data-testid="mock-pick-2026-05-20"
        onClick={() => onSelect(new Date(2026, 4, 20))}
      >pick 2026-05-20</button>
      <button
        data-testid="mock-pick-2026-05-21"
        onClick={() => onSelect(new Date(2026, 4, 21))}
      >pick 2026-05-21</button>
    </div>
  ),
}));

function makeProps(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  return {
    cameras: ['cam-front', 'cam-back'],
    selectedCameras: [],
    mode: 'range' as const,
    dateFrom: '',
    dateTo: '',
    timeFrom: '',
    timeTo: '',
    rangeFrom: '',
    rangeTo: '',
    onApply: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
}

describe('FilterBar — Apply button & dirty state', () => {
  it('Apply button is disabled when draft equals props (not dirty)', () => {
    const props = makeProps();
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    const apply = screen.getByRole('button', { name: /apply/i });
    expect(apply).toBeDisabled();
  });

  it('Defaults to all cameras checked with no active filter', () => {
    const props = makeProps();
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    expect(screen.getByRole('checkbox', { name: 'cam-front' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'cam-back' })).toBeChecked();
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  });

  it('Apply button enables after toggling a camera', () => {
    const props = makeProps();
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'cam-front' })); // uncheck
    expect(screen.getByRole('button', { name: /apply/i })).toBeEnabled();
  });

  it('Unchecking one camera applies the remaining cameras', () => {
    const onApply = vi.fn();
    const props = makeProps({ onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'cam-front' })); // uncheck front
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({ selectedCameras: ['cam-back'] });
  });

  it('Select none then check one applies just that camera', () => {
    const onApply = vi.fn();
    const props = makeProps({ onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-camfilter-none'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'cam-front' }));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ selectedCameras: ['cam-front'] });
  });

  it('Select all clears the camera filter (applies empty = all)', () => {
    const onApply = vi.fn();
    const props = makeProps({ selectedCameras: ['cam-front'], onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-camfilter-all'));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({ selectedCameras: [] });
  });

  // "none" and "all" both mean "no filter" (the grid can't show zero cameras),
  // so Select-none from the default no-filter state is a no-op and must leave
  // Apply disabled — don't let a future change "enable" applying an empty set.
  it('Select none from the default state leaves Apply disabled (none clamps to all)', () => {
    const props = makeProps();
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-camfilter-none'));
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  });

  it('Search narrows the camera list', () => {
    const props = makeProps();
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.change(screen.getByTestId('filter-camfilter-search'), { target: { value: 'front' } });
    expect(screen.getByRole('checkbox', { name: 'cam-front' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'cam-back' })).not.toBeInTheDocument();
  });

  // The picker mirrors the timeline: a colour dot per camera from the shared
  // palette so a camera reads as the same hue in the filter and the timeline.
  // (We assert one dot per row, not the hsl value — jsdom's CSSOM drops the
  // modern `hsl(... deg ...% ...%)` syntax the palette emits, so a colour
  // readback would always be empty here even though browsers render it.)
  it('renders a colored dot per camera from the shared palette', () => {
    const props = makeProps();
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    const dots = document.querySelectorAll('.timeline-camera-dot');
    expect(dots).toHaveLength(props.cameras.length);
  });

  it('Closing the panel without applying discards the draft', () => {
    const onApply = vi.fn();
    const props = makeProps({ onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'cam-front' })); // uncheck
    fireEvent.click(screen.getByRole('button', { name: /filter/i })); // close
    fireEvent.click(screen.getByRole('button', { name: /filter/i })); // re-open
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Props change re-syncs draft (external URL navigation)', () => {
    const props = makeProps();
    const { rerender } = render(<FilterBar {...props} />);
    rerender(<FilterBar {...props} selectedCameras={['cam-back']} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    expect(screen.getByRole('checkbox', { name: 'cam-back' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'cam-front' })).not.toBeChecked();
  });
});

describe('FilterBar — Pora dnia auto-fill (calendar picker)', () => {
  it('Picking dateFrom via the calendar sets timeFrom=00:00 when empty', () => {
    const onApply = vi.fn();
    const props = makeProps({ mode: 'daily', onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-date-trigger-dateFrom'));
    fireEvent.click(screen.getByTestId('mock-pick-2026-05-20'));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({
      dateFrom: '2026-05-20',
      timeFrom: '00:00',
    });
  });

  it('Picking dateTo via the calendar sets timeTo=23:59 when empty', () => {
    const onApply = vi.fn();
    const props = makeProps({ mode: 'daily', onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-date-trigger-dateTo'));
    fireEvent.click(screen.getByTestId('mock-pick-2026-05-21'));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({
      dateTo: '2026-05-21',
      timeTo: '23:59',
    });
  });

  it('Picking dateFrom preserves a non-empty timeFrom (no overwrite)', () => {
    const onApply = vi.fn();
    const props = makeProps({ mode: 'daily', timeFrom: '08:30', onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-date-trigger-dateFrom'));
    fireEvent.click(screen.getByTestId('mock-pick-2026-05-20'));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({
      dateFrom: '2026-05-20',
      timeFrom: '08:30',
    });
  });
});

describe('FilterBar — Zakres czasu auto-fill (calendar picker)', () => {
  it('Picking a date in rangeFrom auto-fills time to 00:00', () => {
    const onApply = vi.fn();
    const props = makeProps({ mode: 'range', onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-date-trigger-rangeFrom'));
    fireEvent.click(screen.getByTestId('mock-pick-2026-05-20'));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({
      rangeFrom: '2026-05-20T00:00',
    });
  });

  it('Picking a date in rangeTo auto-fills time to 23:59', () => {
    const onApply = vi.fn();
    const props = makeProps({ mode: 'range', onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-date-trigger-rangeTo'));
    fireEvent.click(screen.getByTestId('mock-pick-2026-05-20'));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({
      rangeTo: '2026-05-20T23:59',
    });
  });

  it('Picking a new date preserves the time the user already typed', () => {
    const onApply = vi.fn();
    const props = makeProps({ mode: 'range', rangeTo: '2026-05-20T15:00', onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-date-trigger-rangeTo'));
    fireEvent.click(screen.getByTestId('mock-pick-2026-05-21'));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({
      rangeTo: '2026-05-21T15:00',
    });
  });

  it('Time input is disabled until a date has been picked', () => {
    const props = makeProps({ mode: 'range' });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    const timeInput = screen.getByLabelText(/rangeFrom From hour/i);
    expect(timeInput).toBeDisabled();
  });

  it('Time input becomes editable after a date is picked and edits write back', () => {
    const onApply = vi.fn();
    const props = makeProps({ mode: 'range', onApply });
    render(<FilterBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    fireEvent.click(screen.getByTestId('filter-date-trigger-rangeFrom'));
    fireEvent.click(screen.getByTestId('mock-pick-2026-05-20'));
    const timeInput = screen.getByLabelText(/rangeFrom From hour/i);
    expect(timeInput).toBeEnabled();
    fireEvent.change(timeInput, { target: { value: '08:30' } });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply.mock.calls[0][0]).toMatchObject({
      rangeFrom: '2026-05-20T08:30',
    });
  });
});
