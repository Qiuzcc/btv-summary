import { describe, expect, it } from 'vitest'
import type { Segment, TranscriptDTO } from '../src/shared/types'
import {
  chunkSegments,
  formatTs,
  parseTranscript,
  safeDirname,
  serializeTranscript
} from '../src/shared/transcript'

describe('时间戳格式（对齐 Python format_ts）', () => {
  it('formatTs 不足 1 小时省略小时位', () => {
    expect(formatTs(0)).toBe('00:00')
    expect(formatTs(75.9)).toBe('01:15')
    expect(formatTs(3661)).toBe('01:01:01')
    expect(formatTs(-5)).toBe('00:00')
  })
})

describe('分块（对齐 chunk_segments 双阈值）', () => {
  const seg = (start: number, end: number, text: string): Segment => ({
    start,
    end,
    text
  })

  it('达到秒数阈值切块', () => {
    const segments = [
      seg(0, 100, 'a'.repeat(10)),
      seg(100, 200, 'b'.repeat(10)),
      seg(200, 250, 'c'.repeat(10))
    ]
    const chunks = chunkSegments(segments, 150, 10_000)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].map((s) => s.text)).toEqual(['a'.repeat(10), 'b'.repeat(10)])
    expect(chunks[1]).toHaveLength(1)
  })

  it('达到字数阈值也切块，尾部残余保留', () => {
    const segments = [seg(0, 10, 'aaaa'), seg(10, 20, 'bb'), seg(20, 30, 'cc')]
    const chunks = chunkSegments(segments, 9999, 4)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(1)
    expect(chunks[1]).toHaveLength(2)
  })
})

describe('safeDirname（对齐 _safe_dirname）', () => {
  it('非法字符替换、空白折叠、去首尾点', () => {
    expect(safeDirname('a/b:c?d*e|f"g<h>i', 'BV')).toBe('a_b_c_d_e_f_g_h_i')
    // Python 先把控制字符 \n 替换为 _，再做空白折叠
    expect(safeDirname('  多   空格\n标题  ', 'BV')).toBe('多 空格_标题')
    expect(safeDirname('...标题...', 'BV')).toBe('标题')
  })

  it('空标题回退 BV 号，超长截断 80 字', () => {
    expect(safeDirname('   ', 'BV1234567890')).toBe('BV1234567890')
    const long = '字'.repeat(100)
    expect(safeDirname(long, 'BV')).toHaveLength(80)
  })
})

describe('Transcript JSON 往返（对齐 to_dict / from_dict）', () => {
  it('默认值与数值转换对齐', () => {
    const dto: TranscriptDTO = {
      bvid: 'BV1',
      title: '',
      owner: '',
      duration: 12.8,
      source: '',
      segments: [{ start: 1, end: 2, text: 't' }]
    }
    const transcript = parseTranscript(dto)
    expect(transcript.title).toBe('BV1')
    expect(transcript.duration).toBe(12)
    expect(transcript.source).toBe('unknown')
    expect(serializeTranscript(transcript).segments[0]).toEqual({
      start: 1,
      end: 2,
      text: 't'
    })
  })
})
