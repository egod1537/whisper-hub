import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';

describe.each([360, 768, 1440])('App responsive smoke at %ipx', (width) => {
  it('keeps every primary panel and action available', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 })));
    render(<App />);

    expect(screen.getByText('Whisper Hub')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '새 전사 작업' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '작업 대기열' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '전사 결과' })).toBeInTheDocument();
    expect(screen.getByLabelText('API 키')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '전사 시작' })).toBeVisible();
  });
});
