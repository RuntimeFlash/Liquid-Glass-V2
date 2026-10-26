module.exports = ({ Main, setClipIfChanged }) => {
  const SHADER_PADDING = 20;
  return class ReferenceDock {
    _syncGeometry() {
        if (!this.glass || !this.targetActor || !this.targetActor.mapped)
            return;
        let sourceActor = this.targetActor;
        let children = this.targetActor.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i].has_style_class_name('dash-background')) {
                children[i].opacity = 0;
                sourceActor = children[i];
            }
        }
        let [baseW, baseH] = sourceActor.get_size();
        let [absX, absY] = sourceActor.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        if (sourceActor !== this.targetActor) {
            let [tX, tY] = this.targetActor.get_transformed_position();
            let [tW, tH] = this.targetActor.get_size();
            if (absX < tX) {
                baseW -= (tX - absX);
                absX = tX;
            }
            if (absY < tY) {
                baseH -= (tY - absY);
                absY = tY;
            }
            if (absX + baseW > tX + tW) {
                baseW = (tX + tW) - absX;
            }
            if (absY + baseH > tY + tH) {
                baseH = (tY + tH) - absY;
            }
        }
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let minCenterDist = -1;
        let distLeftCenter = 0;
        let distRightCenter = 0;
        let distTopCenter = 0;
        let distBottomCenter = 0;
        if (monitor) {
            let dockCenterX = absX + (baseW / 2);
            let dockCenterY = absY + (baseH / 2);
            distLeftCenter = dockCenterX - monitor.x;
            distRightCenter = (monitor.x + monitor.width) - dockCenterX;
            distTopCenter = dockCenterY - monitor.y;
            distBottomCenter = (monitor.y + monitor.height) - dockCenterY;
            minCenterDist = Math.min(distLeftCenter, distRightCenter, distTopCenter, distBottomCenter);
        }
        if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
            let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);
            if (isHorizontalDock) {
                if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1) {
                    baseH = this._lastBaseH;
                }
            }
            else {
                if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1) {
                    baseW = this._lastBaseW;
                }
            }
        }
        this._lastBaseW = baseW;
        this._lastBaseH = baseH;
        let refActor = this._findReferenceActor(this.targetActor);
        if (refActor) {
            let [refW, refH] = refActor.get_size();
            let [refX, refY] = refActor.get_transformed_position();
            if (!Number.isNaN(refX) && !Number.isNaN(refY) && refW > 0 && refH > 0) {
                let topGap = refY - absY;
                let bottomGap = (absY + baseH) - (refY + refH);
                if (topGap < 0 || bottomGap < 0) {
                    let trueRefY = refY - refH;
                    topGap = trueRefY - absY;
                    bottomGap = (absY + baseH) - (trueRefY + refH);
                }
                let leftGap = refX - absX;
                let rightGap = (absX + baseW) - (refX + refW);
                if (leftGap < 0 || rightGap < 0) {
                    let trueRefX = refX - refW;
                    leftGap = trueRefX - absX;
                    rightGap = (absX + baseW) - (trueRefX + refW);
                }
                if (baseW >= baseH) {
                    let diff = Math.abs(bottomGap - topGap);
                    if (diff > 0 && diff < baseH / 2) {
                        if (bottomGap > topGap) {
                            baseH -= diff;
                        }
                        else {
                            absY += diff;
                            baseH -= diff;
                        }
                    }
                }
                else {
                    let diff = Math.abs(rightGap - leftGap);
                    if (diff > 0 && diff < baseW / 2) {
                        if (minCenterDist === distLeftCenter) {
                            if (rightGap > leftGap) {
                                baseW -= diff;
                            }
                        }
                        else {
                            if (rightGap > leftGap) {
                                baseW -= diff;
                            }
                            else {
                                absX += diff;
                                baseW -= diff;
                            }
                        }
                    }
                }
            }
        }
        let marginValue = this._marginValue || 0;
        if (monitor && marginValue > 0) {
            let isMoving = false;
            if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
                let diffX = Math.abs(absX - this._lastAbsX);
                let diffY = Math.abs(absY - this._lastAbsY);
                if (diffX > 1.0 || diffY > 1.0) {
                    isMoving = true;
                }
            }
            this._lastAbsX = absX;
            this._lastAbsY = absY;
            let [tW, tH] = this.targetActor.get_size();
            if (this._stableDeltaW === undefined || this._lastTW !== tW) {
                this._stableDeltaW = baseW - tW;
                this._lastTW = tW;
            }
            if (this._stableDeltaH === undefined || this._lastTH !== tH) {
                this._stableDeltaH = baseH - tH;
                this._lastTH = tH;
            }
            let stableBaseW = tW + this._stableDeltaW;
            let stableBaseH = tH + this._stableDeltaH;
            if (!isMoving) {
                if (minCenterDist === distBottomCenter) {
                    let expectedBottom = monitor.y + monitor.height - marginValue;
                    if (absY + baseH > expectedBottom) {
                        let overflow = (absY + baseH) - expectedBottom;
                        baseH -= overflow;
                    }
                    if (baseH > stableBaseH)
                        baseH = stableBaseH;
                }
                else if (minCenterDist === distTopCenter) {
                    let expectedTop = monitor.y + marginValue;
                    if (absY < expectedTop) {
                        let diff = expectedTop - absY;
                        absY = expectedTop;
                        baseH -= diff;
                    }
                    if (baseH > stableBaseH)
                        baseH = stableBaseH;
                }
                else if (minCenterDist === distRightCenter) {
                    let expectedRight = monitor.x + monitor.width - marginValue;
                    if (absX + baseW > expectedRight) {
                        let overflow = (absX + baseW) - expectedRight;
                        baseW -= overflow;
                    }
                    if (baseW > stableBaseW)
                        baseW = stableBaseW;
                }
                else {
                    let expectedLeft = monitor.x + marginValue;
                    if (absX < expectedLeft) {
                        let diff = expectedLeft - absX;
                        absX = expectedLeft;
                        baseW -= diff;
                    }
                    if (baseW > stableBaseW)
                        baseW = stableBaseW;
                }
            }
        }
        let w = Math.max(1.0, baseW);
        let h = Math.max(1.0, baseH);
        if (baseW <= 9 || baseH <= 9) {
            this.glass.hide();
            this._lastBgW = undefined;
            this._lastBgH = undefined;
            this._lastBgX = undefined;
            this._lastBgY = undefined;
            return;
        }
        else {
            this.glass.show();
        }
        this.glass.opacity = this.targetActor.opacity;
        let visibleW = baseW;
        let visibleH = baseH;
        if (monitor) {
            if (absX < monitor.x)
                visibleW -= (monitor.x - absX);
            if (absY < monitor.y)
                visibleH -= (monitor.y - absY);
            if (absX + baseW > monitor.x + monitor.width)
                visibleW -= ((absX + baseW) - (monitor.x + monitor.width));
            if (absY + baseH > monitor.y + monitor.height)
                visibleH -= ((absY + baseH) - (monitor.y + monitor.height));
        }
        if (visibleW <= 1 || visibleH <= 1) {
            if (this._lastHidden !== true) {
                this._lastHidden = true;
                this._logger.log(`[Liquid Glass][dock] hiding the glass: visible=(${visibleW.toFixed(1)}x${visibleH.toFixed(1)}) ` +
                    `base=(${baseW.toFixed(1)}x${baseH.toFixed(1)}) abs=(${absX.toFixed(1)},${absY.toFixed(1)}) ` +
                    `monitor=(${monitor?.x},${monitor?.y},${monitor?.width}x${monitor?.height}) ` +
                    `margin=${this._marginValue}`);
            }
            this.glass.opacity = 0;
        }
        else {
            if (this._lastHidden === true) {
                this._lastHidden = false;
                this._logger.log('[Liquid Glass][dock] glass visible again');
            }
            this.glass.opacity = this.targetActor.opacity;
        }
        let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgX = absX - SHADER_PADDING - this._glassExpand;
        let bgY = absY - SHADER_PADDING - this._glassExpand;
        let screenW = monitor.width;
        let screenH = monitor.height;
        let localBgX = bgX - monitor.x;
        let localBgY = bgY - monitor.y;
        if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
            this._lastBgX !== bgX || this._lastBgY !== bgY ||
            this._lastScreenW !== screenW || this._lastScreenH !== screenH ||
            this.glass.x !== monitor.x || this.glass.y !== monitor.y) {
            this.glass.remove_transition('size');
            this.glass.remove_transition('position');
            this.glass.set_position(monitor.x, monitor.y);
            this.glass.set_size(screenW, screenH);
            this.glass.remove_transition('size');
            this.glass.remove_transition('position');
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = bgX;
            this._lastBgY = bgY;
            this._lastScreenW = screenW;
            this._lastScreenH = screenH;
        }
        const CLIP_PADDING = 200;
        setClipIfChanged(this.glass, localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
        const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
        this.glass.setShadowMaxRadius(SHADOW_MAX_RADIUS);
        this.glass.setResolution(screenW, screenH);
        this.glass.setGlassGeometry(localBgX, localBgY, bgW, bgH);
        this.glass.syncSources();
    }
  };
};
