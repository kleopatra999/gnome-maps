/* -*- Mode: JS2; indent-tabs-mode: nil; js2-basic-offset: 4 -*- */
/* vim: set et ts=4 sw=4: */
/*
 * GNOME Maps is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * GNOME Maps is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with GNOME Maps; if not, see <http://www.gnu.org/licenses/>.
 *
 * Author: Amisha Singla <amishas157@gmail.com>
 */

const Cairo = imports.cairo;
const Champlain = imports.gi.Champlain;
const Clutter = imports.gi.Clutter;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;

const Application = imports.application;
const InstructionRow = imports.instructionRow;
const MapView = imports.mapView;
const TurnPointMarker = imports.turnPointMarker;

/* Following constant has unit as meters */
const _SHORT_LAYOUT_MAX_DISTANCE = 3000;

const _STROKE_COLOR = new Clutter.Color({ red: 0,
                                          blue: 255,
                                          green: 0,
                                          alpha: 100 });
const _STROKE_WIDTH = 5.0;

/* All following constants are ratios of surface size to page size */
const _Header = {
    SCALE_X: 0.9,
    SCALE_Y: 0.03,
    SCALE_MARGIN: 0.01
};
const _MapView = {
    SCALE_X: 1.0,
    SCALE_Y: 0.4,
    SCALE_MARGIN: 0.04,
    ZOOM_LEVEL: 18
};

function newFromRoute(route, pageWidth, pageHeight) {
    /*
     * To avoid the circular dependencies, imports has
     * been carried out in this method
     */
    if (route.distance > _SHORT_LAYOUT_MAX_DISTANCE) {
        return new imports.longPrintLayout.LongPrintLayout({
            route: route,
            pageWidth: pageWidth,
            pageHeight: pageHeight
        });
    } else {
        return new imports.shortPrintLayout.ShortPrintLayout({
            route: route,
            pageWidth: pageWidth,
            pageHeight: pageHeight
        });
    }
}

const PrintLayout = new Lang.Class({
    Name: 'PrintLayout',
    Extends: GObject.Object,
    Abstract: true,
    Signals: {
        'render-complete': { }
    },

    _init: function(params) {
        this._pageWidth = params.pageWidth;
        delete params.pageWidth;

        this._pageHeight = params.pageHeight;
        delete params.pageHeight;

        this._totalSurfaces = params.totalSurfaces;
        delete params.totalSurfaces;

        this.parent();

        this.numPages = 0;
        this.surfaceObjects = [];
        this._surfacesRendered = 0;
        this.renderFinished = false;
        this._initSignals();
    },

    render: function() {
        let headerWidth = _Header.SCALE_X * this._pageWidth;
        let headerHeight = _Header.SCALE_Y * this._pageHeight;
        let headerMargin = _Header.SCALE_MARGIN * this._pageHeight;

        let mapViewWidth = _MapView.SCALE_X * this._pageWidth;
        let mapViewHeight = _MapView.SCALE_Y * this._pageHeight;
        let mapViewMargin = _MapView.SCALE_MARGIN * this._pageHeight;
        let mapViewZoomLevel = _MapView.ZOOM_LEVEL;

        this._createNewPage();
        let dy = 0;

        /*
         * Before rendering each surface, page adjustment is done. It is checked if it
         * can be adjusted in current page, otherwise a new page is created
         */
        dy = headerHeight + headerMargin;
        this._adjustPage(dy);
        this._drawHeader(headerWidth, headerHeight);
        this._cursorY += dy;

        dy = mapViewHeight + mapViewMargin;
        this._adjustPage(dy);
        let turnPointsLength = this._route.turnPoints.length;
        let allTurnPoints = this._createTurnPointArray(0, turnPointsLength);
        this._drawMapView(mapViewWidth, mapViewHeight,
                          mapViewZoomLevel, allTurnPoints);
        this._cursorY += dy;
    },

    _initSignals: function() {
        this.connect('render-complete', (function() {
            this.renderFinished = true;
        }).bind(this));
    },

    _createMarker: function(turnPoint) {
        return new TurnPointMarker.TurnPointMarker({
            turnPoint: turnPoint,
            queryPoint: {}
        });
    },

    _drawMapView: function(width, height, zoomLevel, turnPoints) {
        let pageNum = this.numPages - 1;
        let x = this._cursorX;
        let y = this._cursorY;
        let factory = Champlain.MapSourceFactory.dup_default();
        let mapSource = factory.create_cached_source(MapView.MapType.STREET);
        let locations = [];
        let markerLayer = new Champlain.MarkerLayer();
        let view = new Champlain.View({ width: width,
                                        height: height,
                                        zoom_level: zoomLevel });
        view.set_map_source(mapSource);
        view.add_layer(markerLayer);

        this._addRouteLayer(view);

        turnPoints.forEach((function(turnPoint) {
            locations.push(turnPoint.coordinate);
            if (turnPoint.isStop()) {
                markerLayer.add_marker(this._createMarker(turnPoint));
            }
        }).bind(this));

        view.ensure_visible(this._route.createBBox(locations), false);
        if (view.state !== Champlain.State.DONE) {
            let notifyId = view.connect('notify::state', (function() {
                if (view.state === Champlain.State.DONE) {
                    view.disconnect(notifyId);
                    let surface = view.to_surface(true);
                    if (surface)
                        this._addSurface(surface, x, y, pageNum);
                }
            }).bind(this));
        } else {
            let surface = view.to_surface(true);
            if (surface)
                this._addSurface(surface, x, y, pageNum);
        }
    },

    _createTurnPointArray: function(startIndex, endIndex) {
        let turnPointArray = [];
        for (let i = startIndex; i < endIndex; i++) {
            turnPointArray.push(this._route.turnPoints[i]);
        }
        return turnPointArray;
    },

    _addRouteLayer: function(view) {
        let routeLayer = new Champlain.PathLayer({ stroke_width: _STROKE_WIDTH,
                                                   stroke_color: _STROKE_COLOR });
        view.add_layer(routeLayer);
        this._route.path.forEach(routeLayer.add_node.bind(routeLayer));
    },

    _drawInstruction: function(width, height, turnPoint) {
        let pageNum = this.numPages - 1;
        let x = this._cursorX;
        let y = this._cursorY;
        let instructionWidget = new Gtk.OffscreenWindow({ visible: true });
        let instructionEntry =  new InstructionRow.InstructionRow({
            visible: true,
            turnPoint: turnPoint,
            hasColor: turnPoint.isStop(),
            lines: 2
        });

        instructionWidget.width_request = width;
        instructionWidget.height_request = height;

        /* Paint the background of the entry to be transparent */
        instructionEntry.connect('draw', (function(widget, cr) {
            cr.setSourceRGBA(0.0, 0.0, 0.0, 0.0);
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
        }).bind(this));

        instructionEntry.queue_draw();
        instructionWidget.add(instructionEntry);
        instructionWidget.set_valign(Gtk.Align.START);
        instructionWidget.connect('damage-event', (function(widget) {
            let surface = widget.get_surface();
            this._addSurface(surface, x, y, pageNum);
        }).bind(this));
    },

    _drawHeader: function(width, height) {
        let pageNum = this.numPages - 1;
        let x = this._cursorX;
        let y = this._cursorY;
        let surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
        let cr = new Cairo.Context(surface);
        let layout = PangoCairo.create_layout(cr);
        let from = this._formatQueryPlaceName(0);
        let to = this._formatQueryPlaceName(-1);
        let header = _("From %s to %s").format(from, to);
        let desc = Pango.FontDescription.from_string("sans");

        layout.set_text(header, -1);
        layout.set_height(Pango.units_from_double(height));
        layout.set_width(Pango.units_from_double(width));
        layout.set_font_description(desc);
        layout.set_alignment(Pango.Alignment.CENTER);
        PangoCairo.layout_path(cr, layout);
        cr.setSourceRGB(0.0,0.0,0.0);
        cr.fill();

        this._addSurface(surface, x, y, pageNum);
    },

    _addSurface: function(surface, x, y, pageNum) {
        this.surfaceObjects[pageNum].push({ surface: surface, x: x, y: y });
        this._surfacesRendered++;
        if (this._surfacesRendered === this._totalSurfaces)
            this.emit('render-complete');
    },

    _adjustPage: function(dy) {
        if (this._cursorY + dy > this._pageHeight)
            this._createNewPage();
    },

    _createNewPage: function() {
        this.numPages++;
        this.surfaceObjects[this.numPages - 1] = [];
        this._cursorX = 0;
        this._cursorY = 0;
    },

    _formatQueryPlaceName: function(index) {
        let query = Application.routeService.query;
        if (index === -1)
            index = query.filledPoints.length - 1;
        let name;
        let place = query.filledPoints[index].place;
        if (place.name) {
            name = place.name;
            if (name.length > 25)
                name = name.substr(0, 22) + '\u2026';
        } else {
            let lat = place.location.latitude.toFixed(5);
            let lon = place.location.latitude.toFixed(5);
            name = '%s, %s'.format(lat, lon);
        }

        return name;
    }
});
