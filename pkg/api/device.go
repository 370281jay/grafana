package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/grafana/grafana/pkg/api/response"
	"github.com/grafana/grafana/pkg/api/routing"
	"github.com/grafana/grafana/pkg/middleware"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/services/devices"
	"github.com/grafana/grafana/pkg/web"
)

func (hs *HTTPServer) registerDeviceAPI(apiRoute routing.RouteRegister) {
	reqSignedIn := middleware.ReqSignedIn

	apiRoute.Get("/devices", reqSignedIn, routing.Wrap(hs.listDevices))
	apiRoute.Post("/devices", reqSignedIn, routing.Wrap(hs.createDevice))
	apiRoute.Get("/devices/:id", reqSignedIn, routing.Wrap(hs.getDevice))
	apiRoute.Put("/devices/:id", reqSignedIn, routing.Wrap(hs.updateDevice))
	apiRoute.Delete("/devices/:id", reqSignedIn, routing.Wrap(hs.deleteDevice))
}

func (hs *HTTPServer) listDevices(c *contextmodel.ReqContext) response.Response {
	query := &devices.ListDevicesQuery{OrgID: c.OrgID}
	items, err := hs.deviceService.List(c.Req.Context(), query)
	if err != nil {
		return response.Error(http.StatusInternalServerError, "Failed to get devices", err)
	}

	return response.JSON(http.StatusOK, toDeviceDTOs(items))
}

func (hs *HTTPServer) getDevice(c *contextmodel.ReqContext) response.Response {
	id, err := parseDeviceID(c)
	if err != nil {
		return response.Error(http.StatusBadRequest, "Invalid device id", err)
	}

	query := &devices.GetDeviceQuery{OrgID: c.OrgID, ID: id}
	device, err := hs.deviceService.Get(c.Req.Context(), query)
	if err != nil {
		return deviceErrorResponse(err)
	}

	return response.JSON(http.StatusOK, toDeviceDTO(device))
}

func (hs *HTTPServer) createDevice(c *contextmodel.ReqContext) response.Response {
	cmd := &devices.CreateDeviceCommand{OrgID: c.OrgID}
	if err := web.Bind(c.Req, cmd); err != nil {
		return response.Error(http.StatusBadRequest, "Invalid request body", err)
	}

	created, err := hs.deviceService.Create(c.Req.Context(), cmd)
	if err != nil {
		return deviceErrorResponse(err)
	}

	return response.JSON(http.StatusOK, toDeviceDTO(created))
}

func (hs *HTTPServer) updateDevice(c *contextmodel.ReqContext) response.Response {
	id, err := parseDeviceID(c)
	if err != nil {
		return response.Error(http.StatusBadRequest, "Invalid device id", err)
	}

	cmd := &devices.UpdateDeviceCommand{OrgID: c.OrgID, ID: id}
	if err := web.Bind(c.Req, cmd); err != nil {
		return response.Error(http.StatusBadRequest, "Invalid request body", err)
	}

	cmd.ID = id

	updated, err := hs.deviceService.Update(c.Req.Context(), cmd)
	if err != nil {
		return deviceErrorResponse(err)
	}

	return response.JSON(http.StatusOK, toDeviceDTO(updated))
}

func (hs *HTTPServer) deleteDevice(c *contextmodel.ReqContext) response.Response {
	id, err := parseDeviceID(c)
	if err != nil {
		return response.Error(http.StatusBadRequest, "Invalid device id", err)
	}

	cmd := &devices.DeleteDeviceCommand{OrgID: c.OrgID, ID: id}
	if err := hs.deviceService.Delete(c.Req.Context(), cmd); err != nil {
		return deviceErrorResponse(err)
	}

	return response.Success("Device deleted")
}

func parseDeviceID(c *contextmodel.ReqContext) (int64, error) {
	return strconv.ParseInt(web.Params(c.Req)[":id"], 10, 64)
}

type deviceDTO struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	DeviceMAC   string `json:"deviceMac"`
	DeviceType  string `json:"deviceType"`
	Description string `json:"description"`
}

func toDeviceDTO(device *devices.Device) deviceDTO {
	return deviceDTO{
		ID:          device.ID,
		Name:        device.Name,
		DeviceMAC:   device.DeviceMAC,
		DeviceType:  device.DeviceType,
		Description: device.Description,
	}
}

func toDeviceDTOs(devices []*devices.Device) []deviceDTO {
	result := make([]deviceDTO, 0, len(devices))
	for _, device := range devices {
		result = append(result, toDeviceDTO(device))
	}
	return result
}

func deviceErrorResponse(err error) response.Response {
	switch {
	case errors.Is(err, devices.ErrCommandValidationFailed):
		return response.Error(http.StatusBadRequest, "Invalid device payload", err)
	case errors.Is(err, devices.ErrDeviceNotFound):
		return response.Error(http.StatusNotFound, "Device not found", err)
	default:
		return response.Error(http.StatusInternalServerError, "Failed to save device", err)
	}
}
