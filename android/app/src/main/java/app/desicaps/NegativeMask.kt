package app.desicaps

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.opengl.GLES20
import android.opengl.GLUtils
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram

/**
 * "Negative" caption text: inverts the video's colours wherever the caption mask is set
 * (the same look as a Difference blend of white text). The web UI renders one mask PNG
 * (white text, alpha = coverage) per caption state; this effect picks the right one per frame.
 */
class NegativeMaskEffect(
    private val w: Int, private val h: Int,
    private val times: LongArray,
    private val ids: IntArray,
    private val frames: Map<Int, Exporter.Frame>
) : GlEffect {
    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(useHdr, this)

    fun idAt(us: Long): Int {
        var lo = 0
        var hi = times.size - 1
        var idx = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (times[mid] <= us) { idx = mid; lo = mid + 1 } else hi = mid - 1
        }
        return if (idx < 0) -1 else ids[idx]
    }

    private class Program(useHdr: Boolean, private val fx: NegativeMaskEffect) :
        BaseGlShaderProgram(useHdr, 1) {

        private val program = GlProgram(VS, FS)
        private val bmp = Bitmap.createBitmap(fx.w, fx.h, Bitmap.Config.ARGB_8888)
        private var tex = 0
        private var curId = Int.MIN_VALUE

        init {
            program.setBufferAttribute(
                "aFramePosition", GlUtil.getNormalizedCoordinateBounds(), GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE
            )
        }

        override fun configure(inputWidth: Int, inputHeight: Int): Size = Size(inputWidth, inputHeight)

        private fun ensureTexture() {
            if (tex != 0) return
            val a = IntArray(1)
            GLES20.glGenTextures(1, a, 0)
            tex = a[0]
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, tex)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            bmp.eraseColor(0)
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0)
        }

        /** Returns true when a mask is active for this frame. */
        private fun updateMask(us: Long): Boolean {
            ensureTexture()
            val id = fx.idAt(us)
            val f = if (id >= 0) fx.frames[id] else null
            val want = if (f == null) -1 else id
            if (want != curId) {
                curId = want
                bmp.eraseColor(0)
                if (f != null) {
                    val src = BitmapFactory.decodeFile(f.file.absolutePath)
                    if (src != null) { Canvas(bmp).drawBitmap(src, f.x, f.y, null); src.recycle() }
                }
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, tex)
                GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, bmp)
            }
            return curId >= 0
        }

        override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
            val on = updateMask(presentationTimeUs)
            program.use()
            program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
            program.setSamplerTexIdUniform("uMask", tex, 1)
            program.setFloatUniform("uOn", if (on) 1f else 0f)
            program.bindAttributesAndUniforms()
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        }

        override fun release() {
            super.release()
            try { program.delete() } catch (_: Exception) {}
            if (tex != 0) { GLES20.glDeleteTextures(1, intArrayOf(tex), 0); tex = 0 }
            bmp.recycle()
        }
    }

    companion object {
        private const val VS = """
attribute vec4 aFramePosition;
varying vec2 vTexSamplingCoord;
void main() {
  gl_Position = aFramePosition;
  vTexSamplingCoord = vec2(aFramePosition.x * 0.5 + 0.5, aFramePosition.y * 0.5 + 0.5);
}
"""
        // Frames inside the effects pipeline are bottom-up (GL convention); the mask bitmap is top-down.
        private const val FS = """
precision mediump float;
uniform sampler2D uTexSampler;
uniform sampler2D uMask;
uniform float uOn;
varying vec2 vTexSamplingCoord;
void main() {
  vec4 c = texture2D(uTexSampler, vTexSamplingCoord);
  float m = uOn * texture2D(uMask, vec2(vTexSamplingCoord.x, 1.0 - vTexSamplingCoord.y)).a;
  gl_FragColor = vec4(mix(c.rgb, vec3(1.0) - c.rgb, m), c.a);
}
"""
    }
}
