package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/grafana/grafana/pkg/api/response"
	"github.com/grafana/grafana/pkg/api/routing"
	"github.com/grafana/grafana/pkg/middleware"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/services/devices"
	"github.com/grafana/grafana/pkg/services/homepagecards"
	"github.com/grafana/grafana/pkg/web"
)

func (hs *HTTPServer) registerHomePageCardAPI(apiRoute routing.RouteRegister) {
	reqSignedIn := middleware.ReqSignedIn

	apiRoute.Get("/home-page-cards", reqSignedIn, routing.Wrap(hs.listHomePageCards))
	apiRoute.Post("/home-page-cards", reqSignedIn, routing.Wrap(hs.createHomePageCard))
	apiRoute.Put("/home-page-cards/:id", reqSignedIn, routing.Wrap(hs.updateHomePageCard))
	apiRoute.Delete("/home-page-cards/:id", reqSignedIn, routing.Wrap(hs.deleteHomePageCard))
}

func (hs *HTTPServer) listHomePageCards(c *contextmodel.ReqContext) response.Response {
	query := &homepagecards.GetHomePageCardsQuery{OrgID: c.OrgID}
	cards, err := hs.homePageCardService.List(c.Req.Context(), query)
	if err != nil {
		return response.Error(http.StatusInternalServerError, "Failed to get home page cards", err)
	}

	return response.JSON(http.StatusOK, toHomePageCardDTOs(cards))
}

func (hs *HTTPServer) createHomePageCard(c *contextmodel.ReqContext) response.Response {
	cmd := &homepagecards.CreateHomePageCardCommand{OrgID: c.OrgID}
	if err := web.Bind(c.Req, cmd); err != nil {
		return response.Error(http.StatusBadRequest, "Invalid request body", err)
	}
	if resp := hs.populateCardDeviceMetadata(c, cmd.DeviceID, &cmd.DeviceMAC, &cmd.DeviceType); resp != nil {
		return resp
	}

	card, err := hs.homePageCardService.Create(c.Req.Context(), cmd)
	if err != nil {
		return homePageCardErrorResponse(err)
	}

	return response.JSON(http.StatusOK, toHomePageCardDTO(card))
}

func (hs *HTTPServer) updateHomePageCard(c *contextmodel.ReqContext) response.Response {
	id, err := getHomePageCardID(c)
	if err != nil {
		return response.Error(http.StatusBadRequest, "Invalid home page card id", err)
	}

	cmd := &homepagecards.UpdateHomePageCardCommand{ID: id, OrgID: c.OrgID}
	if err := web.Bind(c.Req, cmd); err != nil {
		return response.Error(http.StatusBadRequest, "Invalid request body", err)
	}

	cmd.ID = id
	if resp := hs.populateCardDeviceMetadata(c, cmd.DeviceID, &cmd.DeviceMAC, &cmd.DeviceType); resp != nil {
		return resp
	}

	card, err := hs.homePageCardService.Update(c.Req.Context(), cmd)
	if err != nil {
		return homePageCardErrorResponse(err)
	}

	return response.JSON(http.StatusOK, toHomePageCardDTO(card))
}

func (hs *HTTPServer) deleteHomePageCard(c *contextmodel.ReqContext) response.Response {
	id, err := getHomePageCardID(c)
	if err != nil {
		return response.Error(http.StatusBadRequest, "Invalid home page card id", err)
	}

	cmd := &homepagecards.DeleteHomePageCardCommand{ID: id, OrgID: c.OrgID}
	if err := hs.homePageCardService.Delete(c.Req.Context(), cmd); err != nil {
		return homePageCardErrorResponse(err)
	}

	return response.Success("Home page card deleted")
}

type homePageCardDTO struct {
	ID           int64  `json:"id"`
	DeviceID     int64  `json:"deviceId"`
	DeviceMAC    string `json:"deviceMac"`
	DeviceType   string `json:"deviceType"`
	CardName     string `json:"cardName"`
	DashboardUID string `json:"dashboardUid"`
	DashboardURL string `json:"dashboardUrl"`
}

func toHomePageCardDTOs(cards []*homepagecards.HomePageCard) []homePageCardDTO {
	result := make([]homePageCardDTO, 0, len(cards))
	for _, card := range cards {
		result = append(result, toHomePageCardDTO(card))
	}
	return result
}

func toHomePageCardDTO(card *homepagecards.HomePageCard) homePageCardDTO {
	dto := homePageCardDTO{
		ID:           card.ID,
		DeviceID:     card.DeviceID,
		DeviceMAC:    card.DeviceMAC,
		DeviceType:   card.DeviceType,
		CardName:     card.CardName,
		DashboardUID: card.DashboardUID,
	}

	if strings.TrimSpace(card.DashboardUID) != "" {
		dto.DashboardURL = "/d/" + strings.TrimSpace(card.DashboardUID)
	}

	return dto
}

func getHomePageCardID(c *contextmodel.ReqContext) (int64, error) {
	return strconv.ParseInt(web.Params(c.Req)[":id"], 10, 64)
}

func homePageCardErrorResponse(err error) response.Response {
	switch {
	case errors.Is(err, homepagecards.ErrCommandValidationFailed):
		return response.Error(http.StatusBadRequest, "Invalid home page card payload", err)
	case errors.Is(err, homepagecards.ErrHomePageCardNotFound):
		return response.Error(http.StatusNotFound, "Home page card not found", err)
	default:
		return response.Error(http.StatusInternalServerError, "Failed to save home page card", err)
	}
}

func (hs *HTTPServer) populateCardDeviceMetadata(c *contextmodel.ReqContext, deviceID int64, deviceMAC *string, deviceType *string) response.Response {
	if deviceID == 0 {
		return nil
	}

	device, err := hs.deviceService.Get(c.Req.Context(), &devices.GetDeviceQuery{OrgID: c.OrgID, ID: deviceID})
	if err != nil {
		return deviceErrorResponse(err)
	}

	if strings.TrimSpace(*deviceMAC) == "" {
		*deviceMAC = device.DeviceMAC
	}
	if strings.TrimSpace(*deviceType) == "" {
		*deviceType = device.DeviceType
	}

	return nil
}
